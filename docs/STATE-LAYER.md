# The state layer — architecture and phase-B wiring plan

**Status:** phase A complete. Every module in `workers/state/` exists, is
unit-tested and is wired into nothing. The Worker still deploys exactly as it did
before this branch.

**Audience:** whoever does phase B. Read `workers/state/README.md` first for the
module contracts; this document explains _why the layer looks like this_, what it
costs, and exactly what has to change to switch it on.

---

## 1. The problem

Six audit findings share one root cause: **this shop has no server-side state.**

| Finding         | What it actually is                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1             | Store credit minted from `localStorage["yl_loyalty_points"]`. No ledger exists, so a `POST {"points":500}` is a $25 unlimited-use coupon.    |
| C-2             | Gift cards applied in the cart drawer are never debited. Two tabs double-spend; the balance checker keeps reporting the full amount.         |
| H-5             | Refund balance restoration is dead code and would double-restore if wired: two event types, two different idempotency keys, neither durable. |
| H-6             | Order status fabricates a confirmed order for any input. There is nothing real to look it up against.                                        |
| H-9             | A sub-step failure 500s the whole webhook, so Stripe retries forever and re-runs the steps that already succeeded.                           |
| Medium/Payments | Balance lookup is an unthrottled validation oracle over a ~1e9 code space; `submit-restock` claims a rate limit it does not have.            |

Stripe is a fine system of record for _orders_. It is not a ledger: promotion
codes have no reserve-then-settle primitive, and a webhook handler with no
durable "have I seen this event" table cannot be idempotent. The missing piece is
a small amount of strongly consistent, server-owned state.

## 2. What was chosen, and what was rejected

### Chosen: SQLite Durable Objects + D1, both on the Workers Free plan

**Gift-card balances → a Durable Object per code.** Every request for
`YALL-GIFT50` is routed by `idFromName("YALL-GIFT50")` to the same object, in one
location, and processed one at a time. That serialisation — not any clever SQL —
is what makes "check the balance, then take it" safe when two tabs check out at
once. The object's SQLite storage keeps the balance, the reservations and an
append-only ledger, updated together in one `transactionSync`.

**Webhook claims, points and burned tokens → D1.** These are keyed by
high-cardinality random ids (`evt_…`, an email, a `jti`) and are never contended:
two deliveries of one Stripe event arrive minutes apart, not microseconds. They
need one cheap conditional insert, not a serialisation domain. `INSERT OR IGNORE`
plus `meta.changes` is exactly that, at one query per webhook.

**Orders stay in Stripe.** Copying them into D1 would double the number of places
that can be wrong with nothing to reconcile against. `stripe-orders.js` reads
through to the API and sanitises the result.

### Rejected

| Option                                       | Why not                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workers KV**                               | Eventually consistent — a balance read can return a stale value for up to a minute, which is a double-spend by design. The free plan also caps writes at **1,000/day**; one busy Saturday of reserve+commit traffic would exhaust it and fail silently. Disqualified twice over.                                                                   |
| **Netlify Blobs**                            | Keeps the money path on Netlify, where finding H-23 already bites: the free plan is a 300-credit monthly hard cap and at zero credits **every project pauses**, webhook function included. A ledger that stops answering mid-month is worse than no ledger.                                                                                        |
| **Supabase / Neon / PlanetScale free tiers** | All pause or sleep an idle free project (a cold start in a webhook handler risks a Stripe timeout, and a paused database silently drops the money path), all add a network hop from the Worker, all need a connection strategy Workers do not natively have, and all put customer data in a fourth vendor the privacy policy does not name (H-14). |
| **Cloudflare Queues**                        | Not on the free plan.                                                                                                                                                                                                                                                                                                                              |
| **Stripe metadata as the ledger**            | This is what C-2 already tries. Metadata has no atomic read-modify-write, a 50-key cap per object (already the cause of H-8), and no way to hold a reservation.                                                                                                                                                                                    |
| **Doing nothing until there is a paid plan** | The findings are live on a production storefront.                                                                                                                                                                                                                                                                                                  |

## 3. Free-plan budget

Assumptions: **~1,000 orders/month (≈35/day)**, a 3× peak day, roughly 10 gift
cards sold a month, and 20× the order volume in public balance/status lookups.

| Resource            | Free limit                            | This shop, per day                                                          | Headroom   |
| ------------------- | ------------------------------------- | --------------------------------------------------------------------------- | ---------- |
| Worker requests     | 100,000/day                           | ~2,000 (all `/api/*` traffic)                                               | 50×        |
| **DO requests**     | 100,000/day                           | reserve + commit + release ≈ 3/order ≈ **105**, plus balance checks ≈ 700   | ~100×      |
| DO rows written     | 100,000/day                           | ~5 rows per gift-card mutation ≈ **500**                                    | 200×       |
| DO rows read        | 5,000,000/day                         | a card's ledger is tens of rows; ~10k                                       | 500×       |
| DO storage          | 5 GB                                  | a card is < 2 KB after a year of use; hundreds of cards ≈ 1 MB              | irrelevant |
| **D1 rows written** | 100,000/day (**hard-enforced daily**) | 1 claim + 1 done + 1 loyalty credit per order ≈ **105**, plus burned tokens | ~900×      |
| D1 rows read        | 5,000,000/day                         | indexed lookups by email/event id; ~5k                                      | 1000×      |
| D1 storage          | 500 MB per database, 5 GB total       | ~200 bytes/row; 1,000 orders/month ≈ 0.7 MB/year                            | decades    |
| Stripe API calls    | n/a                                   | 1 per order-status lookup, 1 per checkout                                   | —          |

The margins are not close, which is the point: the design is chosen so that a
bad day cannot push the shop past a hard daily limit. Two things could:

1. **Enumeration of the gift-card balance endpoint.** Each lookup is one DO
   request; 100k guesses in a day exhausts the daily DO allowance and takes the
   balance checker offline for everyone. Mitigation: the balance endpoint uses
   the **Rate Limiting binding** (no DO request, no storage) as its first line,
   and the DO fallback only for authenticated flows. Lengthening the code (the
   Medium finding: 6 chars over a 32-char alphabet, with modulo bias) is the real
   fix and belongs in phase B.
2. **A webhook retry storm.** Bounded by `claimEvent`: a redelivery is one
   indexed read and no writes.

D1's free limits are enforced daily and **hard** — over the line, writes fail
rather than bill. Every table here has a sweeper (`sweepOldEvents`,
`sweepBurnedTokens`) so the row count tracks the last 30 days, not all time.

## 4. Phase-B wiring plan

### 4.1 Enable the bindings

1. `workers/checkout.js` (owned by another agent) re-exports the classes — a DO
   binding is only valid if `main` exports its `class_name`:
   ```js
   export { GiftCardLedger } from "./state/gift-card-ledger.js";
   export { RateLimitCounter } from "./state/rate-limit.js";
   ```
2. Uncomment the four blocks at the foot of `workers/wrangler.toml`, **in the
   same commit as step 1**. They are commented out today precisely because
   Workers Builds redeploys on every push to `main`, and a binding pointing at a
   class that does not exist fails the deploy — which would mean the next urgent
   checkout fix silently never ships.

### 4.2 Which code path calls what

| Trigger                                                           | Today                                                                                                                                    | Phase B                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cart drawer applies a gift card (`checkout.js`, session creation) | mints an ephemeral coupon for `min(total, balance)`, debits nothing (**C-2**)                                                            | `giftCardLedger(env, code).getBalance()` → cap the discount at `balanceCents` → create the session → `reserve({ sessionId: session.id, cents: applied })`. If `reserve` throws `insufficient_balance`, delete the ephemeral coupon and return a 400 the drawer can show. Reserve _after_ the session exists so a failed Stripe call leaves no hold. |
| `checkout.session.completed`                                      | `handleGiftCardRedemption` reads `session.discounts[0].promotion_code`, which is `null` for the drawer path, and returns early (**C-2**) | drive from `session.metadata.gift_card_redeemed_code` (the Worker already writes it) → `commit({ sessionId })`. Then `credit(db, { email, points, orderId: session.id })` for loyalty.                                                                                                                                                              |
| `checkout.session.expired`                                        | nothing                                                                                                                                  | `release({ sessionId, reason: "session_expired" })`. Harmless when the session never reserved.                                                                                                                                                                                                                                                      |
| `charge.refunded`                                                 | dead code that would double-restore (**H-5**)                                                                                            | look the session up by payment intent, then `restore({ chargeId: refund.id, cents: Math.min(applied, refunded) })` — idempotent per charge/refund id, so subscribing to one event type is enough.                                                                                                                                                   |
| Every webhook, before anything else                               | ad-hoc idempotency keys (**H-9**)                                                                                                        | `claimEvent(db, event.id, event.type)` → work → `markEventDone`; `releaseEvent` in the catch. Each sub-step in its own try/catch so a rollover failure cannot block gift-card delivery.                                                                                                                                                             |
| Gift card sold                                                    | `fulfill-gift-card.js` creates the promo code and emails it                                                                              | additionally `issue({ code, initialCents, recipientEmail, source: "checkout", stripePromoId })` so the ledger knows the card exists.                                                                                                                                                                                                                |
| Points redemption (**C-1**)                                       | unauthenticated coupon minting                                                                                                           | magic-link token → `debit(db, …)` → only then mint a `duration: "once"`, `max_redemptions: 1` promotion code.                                                                                                                                                                                                                                       |
| A 24h-old unpaid session                                          | nothing                                                                                                                                  | the DO alarm releases the hold by itself.                                                                                                                                                                                                                                                                                                           |

### 4.3 Netlify functions become Worker routes

All four move into the Worker, because the state layer lives there and because
H-23 means the Netlify free plan can pause the whole site mid-month. Netlify
keeps serving the static site and proxies `/api/*`.

| Route                              | Replaces                                           | Request                           | Response                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | -------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/gift-card-balance?code=` | `gift-card-balance.js`                             | query `code`                      | `200 {valid:true, code, balanceCents, balance, formattedBalance, pendingCents, initialAmountCents, currency}` / `404 {valid:false, error}`. **`Cache-Control: no-store`** (finding C-3) and rate-limited by IP. Response shape is a superset of today's so `assets/js/gift-card.js` and the cart keep working. |
| `POST /api/stripe-webhook`         | `fulfill-gift-card.js`                             | Stripe event + `Stripe-Signature` | `200 {received:true}`; `400` only for a bad signature. Non-2xx _only_ when a retry would help.                                                                                                                                                                                                                 |
| `POST /api/order-status`           | the fabricated `order-status.html` logic (**H-6**) | `{sessionId, email}`              | `200 {found:true, status, paymentStatus, amountTotalCents, currency, placedAt, items:[{name,quantity}], shipTo:{city,state,country}, fulfilment:{status,trackingUrl,shippedAt}}` / `200 {found:false, error:"not_found"}` — identical for a wrong email and a missing session. Rate-limited by IP.             |
| `POST /api/restock`                | `submit-restock.js`                                | `{productId, email}`              | `202 {ok:true}`. Actually rate-limited this time, and the submission is stored rather than discarded.                                                                                                                                                                                                          |
| `POST /api/magic-link`             | new                                                | `{email, purpose}`                | always `202 {ok:true}` (never reveal whether the address is known); emails a link. `GET /api/magic-link?token=` verifies + burns and returns `{ok, purpose, email}`.                                                                                                                                           |

Client contracts are additive: no existing response field changes meaning, so
the front-end agents can migrate page by page.

### 4.4 Ordering

Ship in this order so each step is independently revertable:

1. Bindings + class exports (deploys, changes no behaviour).
2. `/api/stripe-webhook` with `claimEvent` only — proves exactly-once against
   real Stripe traffic before any balance moves.
3. `issue` on gift-card sale; `getBalance` behind the balance route (read-only).
4. `reserve`/`commit`/`release` in checkout (**C-2 closed**).
5. `restore` on refunds (**H-5 closed**).
6. Loyalty credit, then magic link, then debit (**C-1 closed**).
7. `/api/order-status` (**H-6 closed**).

## 5. Dashboard setup (one-time, by hand)

```bash
# 1. D1 database — prints the database_id for wrangler.toml
npx wrangler d1 create yallternative-state

# 2. Load the schema (also applied automatically at first request by migrations.js)
npx wrangler d1 execute yallternative-state --remote --file=workers/schema.sql

# 3. Secrets — never [vars], never committed
npx wrangler secret put MAGIC_LINK_SECRET      # 32+ random bytes
npx wrangler secret put STRIPE_WEBHOOK_SECRET  # from the Stripe endpoint below
```

Then, by hand:

- **Cloudflare → Workers & Pages → the Worker → Settings → Domains & Routes.**
  Add routes on the custom domain for `/api/gift-card-balance`,
  `/api/stripe-webhook`, `/api/order-status`, `/api/restock`, `/api/magic-link`.
  Use the apex domain, not `*.workers.dev` — the Medium finding stands: if that
  subdomain is ever released, whoever claims it receives the traffic.
- **Cloudflare → the Worker → Settings → Bindings.** Confirm `GIFT_CARD_LEDGER`,
  `RATE_LIMIT_COUNTER` and `STATE_DB` appear after the first deploy.
- **Stripe → Developers → Webhooks.** Point the endpoint at
  `https://yallternativeliving.com/api/stripe-webhook` and subscribe to
  `checkout.session.completed`, `checkout.session.expired` and `charge.refunded`.
  Copy the new signing secret into `STRIPE_WEBHOOK_SECRET`. The old Netlify
  endpoint stays enabled until the Worker has processed real events, then is
  deleted — both can run at once, because `claimEvent` makes double processing
  impossible only _within_ one deployment. Run them in parallel for observation
  only, not for fulfilment.
- **Netlify.** `netlify.toml` needs a proxy rule per route, alongside the
  existing `/api/checkout` one. It is generated by
  `scripts/build-security-headers.js`, so the rules go in that generator, not in
  the committed file.
- **Cron.** Add a `[triggers] crons = ["17 4 * * *"]` schedule calling
  `sweepOldEvents` and `sweepBurnedTokens`.

## 6. Two things to verify in a dashboard before relying on them

Neither can be checked from the repository.

1. **Is the Rate Limiting binding available on this account's Free plan?**
   `workers/state/rate-limit.js` uses `env.RATE_LIMITER` when it exists and falls
   back to the exact Durable Object counter when it does not, so both cases work
   — but which one is running decides the DO request budget in §3. Check
   Cloudflare → the Worker → Settings → Bindings for a "Rate limiting" binding
   type. If it is not offered, either accept the DO cost on public endpoints or
   drop rate limiting on the balance route to a cheap in-isolate heuristic and
   rely on a longer gift-card code.
2. **What Netlify plan is this site on? (finding H-23.)** The free plan is a
   300-credit monthly hard cap — production deploys at 15 credits each, and every
   Sveltia CMS save triggers one — and at zero credits _every project pauses_,
   including any function still on the money path. Moving `/api/*` to the Worker
   is what makes that survivable, but until the migration is finished, confirm
   the plan and put a card on file so it bills instead of pausing.

## 7. Open questions for phase B

- **Where do gift-card codes get _created_?** `fulfill-gift-card.js` derives them
  from the session id with `deriveGiftCardCode`, which the audit flags for modulo
  bias and a 6-character suffix. `issue()` accepts whatever it is given; phase B
  should lengthen and de-bias the code at the same time, since the ledger makes
  the balance real and therefore worth guessing.
- **RPC or fetch?** The DO is addressed over `fetch` today so the Node tests can
  drive it. Switching to `extends DurableObject` + RPC is a two-line change and
  slightly cheaper; decide once, in one place.
- **Points earning rate and expiry.** `loyalty.js` stores whatever is credited;
  nothing yet decides how many points an order earns, or whether they expire.
- **Do reservations need to survive a code change?** If a card is ever reissued
  under a new code, its DO does not follow. Today codes are immutable.
