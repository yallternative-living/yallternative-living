# The state layer — architecture, and the routes built on it

**Status: phase B done.** The bindings are live in `workers/wrangler.toml`, the
Worker exports the Durable Object classes, and gift cards, the Stripe webhook,
order status and restock all run on this layer. What is NOT done, and is called
out as such in §4.5: loyalty points and magic links. Their modules
(`workers/state/loyalty.js`, `workers/state/magic-link.js`) are still wired into
nothing, deliberately.

**One thing has to happen before the next push to `main`:** `wrangler.toml`
declares a D1 database whose `database_id` is a placeholder, so `wrangler deploy`
fails until it is replaced with the id printed by `wrangler d1 create` (§5). The
Worker itself degrades honestly if the binding is missing at runtime — checkout
keeps working, `/api/stripe-webhook` and `/api/gift-card-balance` answer 503 —
but the deploy is the thing that breaks first.

**Audience:** whoever changes this next. Read `workers/state/README.md` for the
module contracts and `workers/README.md` for the deploy checklist; this document
explains _why the layer looks like this_, what it costs, and what is wired to
what.

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
   request; 100k guesses in a day would exhaust the daily DO allowance and take
   the balance checker offline for everyone. Three things stand in the way now:
   the route is rate-limited to 10/min per IP, the code space is 32^12 rather
   than the biased ~1e9 the Medium finding measured (§4.3), and enabling the
   **Rate Limiting binding** would move the counting off Durable Objects
   entirely (§6.1). As shipped, the DO counter is what runs, so a distributed
   attacker still spends the budget one request at a time — the binding is the
   answer if that ever happens.
2. **A webhook retry storm.** Bounded by `claimEvent`: a redelivery is one
   indexed read and no writes.

D1's free limits are enforced daily and **hard** — over the line, writes fail
rather than bill. Every table here has a sweeper (`sweepOldEvents`,
`sweepBurnedTokens`) so the row count tracks the last 30 days, not all time.

## 4. What is wired to what

### 4.1 The bindings

`workers/checkout.js` — the Worker's `main` — re-exports the classes, which is
what makes a `class_name` in a binding legal:

```js
export { GiftCardLedger } from "./state/gift-card-ledger.js";
export { RateLimitCounter } from "./state/rate-limit.js";
```

`workers/wrangler.toml` declares `GIFT_CARD_LEDGER`, `RATE_LIMIT_COUNTER`, the
`new_sqlite_classes` migration and `STATE_DB`. The optional `RATE_LIMITER`
binding stays commented out: `checkRateLimit` uses it when present and falls back
to the exact Durable Object counter when it is not, so the shipped configuration
works either way (§6.1).

### 4.2 The route contract, as implemented

Everything is `POST`, JSON in and JSON out, `Cache-Control: no-store` on every
response, CORS limited to the apex and www origins with `Vary: Origin`, `OPTIONS`
answered as a 204 preflight, and anything else a JSON 404.

Netlify proxies `/api/*` to the Worker with `:splat`, which **drops the `/api`
prefix** — `/api/order-status` arrives as `/order-status`. `routeOf()` accepts
both spellings so the same build works behind the proxy or on a Cloudflare route.

| Route                    | Request                                     | Response                                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/checkout`          | the cart payload, optionally `giftCardCode` | `200 {url}`; `400 {error}` for anything the shopper can fix; **`409 {error}`** when the gift-card balance moved under a live session                                                                                                                                            |
| `/api/gift-card-balance` | `{code}`                                    | `200 {valid:true, code, balanceCents, balance, formattedBalance, pendingCents, initialAmountCents, initialAmount, currency, expires:null}`; `404 {valid:false, error}` for a bad format AND for unknown/spent/empty (one generic sentence); `429`; `503` with no ledger binding |
| `/api/stripe-webhook`    | Stripe event + `Stripe-Signature`           | `200 {received:true}` (`{received:true, duplicate:true}` on a redelivery); `400 {error:"Invalid signature"}`, one fixed string; `500` only when a retry would help; `503` with no state bindings                                                                                |
| `/api/order-status`      | `{sessionId, email}`                        | `200 {found:true, status, paymentStatus, amountTotal, amountTotalCents, currency, placedAt, sessionId, items:[{name, quantity}], shipping:{city,state}, fulfillment:{status, trackingUrl, shippedAt}}`; `404 {found:false, error:"not_found"}`; `429`                           |
| `/api/restock`           | `{email, product, website_hp}`              | `200 {success:true, message}`; `400` for an invalid address; `429`; `502` when the mailer refuses; `503` with no `RESEND_API_KEY`                                                                                                                                               |

Notes that are contract, not detail:

- **`amountTotal` is cents**, as Stripe reports it. `amountTotalCents` carries the
  same number so no caller has to guess at the unit.
- **`/api/order-status` never returns the street address, the phone number or the
  email.** A wrong email and a session that does not exist return a
  byte-identical `404`, so the endpoint cannot be used to test whether a `cs_…`
  is real.
- **A gift-card balance miss is one answer.** "No such code", "issued but spent"
  and "zero balance" all return the same 404 and the same sentence. A malformed
  code is the exception — that is a typo the shopper can fix, it costs no lookup,
  and it reveals nothing.
- **The restock honeypot returns the success shape**, sends nothing, and logs
  nothing.

Rate limits, per IP, via `checkRateLimit`: 10/min on the balance route, 5/min on
order status and restock. The IP is the first `X-Forwarded-For` entry (Netlify's
record of the client) falling back to `CF-Connecting-IP` — `CF-Connecting-IP`
alone would be Netlify's edge address and put every visitor in one bucket. That
first entry is client-influenced, which is acceptable only because nothing is
authorised by it.

### 4.3 Gift cards: what each event does

| Trigger                                          | What happens                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cart applies a gift card (`/api/checkout`)       | `getBalance()` → cap the discount at `balanceCents` → mint a single-use `duration:"once"` coupon → create the session → `reserve({sessionId, cents})`. Reserving LAST means a failed Stripe call leaves no hold. If `reserve` refuses, the coupon is deleted, the session is **expired** (so nobody can return to that tab and pay a discounted total), and the shopper gets a 409. |
| `checkout.session.completed`, order used a card  | `commit({sessionId})` from `session.metadata.gift_card_redeemed_code`, then a balance-update email. Idempotent.                                                                                                                                                                                                                                                                     |
| `checkout.session.completed`, order bought cards | for each `gift_card_N_*` group expanded by `_qty`: derive the code, `issue(...)`, email recipient and buyer.                                                                                                                                                                                                                                                                        |
| `checkout.session.expired`                       | `release({sessionId, reason:"session_expired"})` and delete the ephemeral coupon.                                                                                                                                                                                                                                                                                                   |
| `charge.refunded`                                | find the session by `payment_intent`, `restore` `min(applied, refunded)` minus whatever is already restored for that charge.                                                                                                                                                                                                                                                        |
| Every webhook, before anything else              | `claimEvent(db, event.id, event.type)` → work → `markEventDone`; `releaseEvent` in the catch. Each sub-step has its own try/catch, so one failure cannot block the others (H-9).                                                                                                                                                                                                    |
| A 24h-old unpaid session                         | the Durable Object's alarm releases the hold by itself.                                                                                                                                                                                                                                                                                                                             |

**Stripe promotion codes are out of the gift-card path entirely.** There is no
rollover, no per-card promotion code, and the webhook never inspects
`session.discounts`. `allow_promotion_codes` stays on the hosted page for
MARKETING codes, and only when no gift card is applied — Stripe will not accept a
session carrying both `discounts` and `allow_promotion_codes` anyway.

**Codes.** `YALL-XXXX-XXXX-XXXX`: 12 symbols over Crockford base32 (no I/L/O/U),
so 32^12 ≈ 1.15e18. 32 divides 256, so a byte maps to a symbol with no modulo
bias — the open question in the old §7 about the 8-character, 36-symbol,
biased derivation is closed. A purchased card's code is
`HMAC(STRIPE_WEBHOOK_SECRET, "gift-code-<session>-<line>-<unit>")`, so a
redelivered webhook re-derives the same string and `issue()` no-ops. Random codes
(`randomGiftCardCode`) use `crypto.getRandomValues` with rejection sampling.

There was **no migration**, because no gift-card code had ever been issued. The
ledger started empty and stays the only place a balance has ever lived.

### 4.4 The Netlify functions, retired

All four are deleted. `/.netlify/functions/gift-card-balance`, `/redeem-points`,
`/fulfill-gift-card` and `/submit-restock` answer **410 Gone** from
`netlify.toml` (generated by `scripts/build-security-headers.js`) — 404 would
say "try again later"; 410 tells a cached client, a crawler and a stale service
worker to stop asking.

`redeem-points` was not ported. Audit C-1: it minted real, cash-like store credit
for anyone who could POST to it, and there is no server-side points ledger for a
rebuilt version to spend from. Rebuilding it is §4.5.

### 4.5 Deliberately still unwired

- **`workers/state/loyalty.js`** — the D1 points ledger exists and is tested, but
  nothing credits or debits it. Nothing yet decides how many points an order
  earns or whether they expire, and a ledger with an undecided earning rate is
  worse than none.
- **`workers/state/magic-link.js`** — HMAC tokens and the single-use burn exist
  and are tested. They are the missing half of C-1: redeeming points has to be
  tied to a verified email before a redemption can mint anything. Until both of
  those land, points redemption stays gone rather than disabled.
- **The cron sweeps.** `checkout.js` has a `scheduled()` handler that calls
  `sweepOldEvents`, but `wrangler.toml` has no `[triggers]` block, so nothing
  runs it. Add `crons = ["17 4 * * *"]` when the `webhook_events` table starts
  mattering; at current volume it will not for a long time.

## 5. Dashboard setup (one-time, by hand)

`workers/README.md` has this as a numbered checklist with the reasoning; the
short version:

```bash
# 1. D1 database — prints the database_id. PASTE IT INTO workers/wrangler.toml.
#    `wrangler deploy` fails until you do.
npx wrangler d1 create yallternative-state

# 2. Load the schema (also applied automatically at first request by migrations.js)
npx wrangler d1 execute yallternative-state --remote --file=workers/schema.sql

# 3. Secrets — never [vars], never committed
npx wrangler secret put STRIPE_SECRET_KEY      # Checkout Sessions, Coupons, Customers write; Tax Settings read
npx wrangler secret put STRIPE_WEBHOOK_SECRET  # from the Stripe endpoint below
npx wrangler secret put RESEND_API_KEY         # from a Resend account with this domain verified
# optional vars: RESTOCK_NOTIFY_EMAIL, GIFT_CARD_FROM_EMAIL
# MAGIC_LINK_SECRET is NOT needed yet — magic links are unwired (§4.5)
```

Then, by hand:

- **Stripe → Developers → Webhooks.** Point the endpoint at
  `https://yallternativeliving.com/api/stripe-webhook` and subscribe to
  `checkout.session.completed`, `checkout.session.expired` and `charge.refunded`.
  Copy the signing secret into `STRIPE_WEBHOOK_SECRET`. That URL reaches the
  Worker through the Netlify proxy, which **must forward the raw body
  unchanged** — the signature is computed over the exact bytes. If Stripe reports
  signature failures, suspect that first; the fallback is to register
  `https://yallternative-checkout.y-allternative-living.workers.dev/stripe-webhook`
  directly (note the missing `/api`: the proxy's `:splat` drops the prefix, and
  the router accepts both).
  The old Netlify endpoint stays enabled until the Worker has processed real
  events, then is deleted — both can run at once for **observation only**,
  because `claimEvent` makes double processing impossible only _within_ one
  deployment.
- **Cloudflare → the Worker → Settings → Bindings.** Confirm `GIFT_CARD_LEDGER`,
  `RATE_LIMIT_COUNTER` and `STATE_DB` appear after the first deploy.
- **Cloudflare → Workers & Pages → the Worker → Settings → Domains & Routes.**
  Optional. Traffic reaches the Worker through Netlify's `/api/*` proxy today, so
  no route is required. Adding `yallternativeliving.com/api/*` removes the hop —
  and the Medium finding about `*.workers.dev` still stands: if that subdomain is
  ever released, whoever claims it receives the traffic.
- **Netlify.** The proxy rule and the four `410` rules are generated by
  `scripts/build-security-headers.js`, not hand-written — that script rewrites
  `netlify.toml` on every deploy, so an edit made directly there vanishes. Also
  **delete the old function environment variables** (`STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `RESTOCK_NOTIFY_EMAIL`,
  `RESTOCK_FROM_EMAIL`, `GIFT_CARD_FROM_EMAIL`, `FROM_EMAIL`): nothing in the
  Netlify build reads them now, and a live Stripe key in a second provider's
  dashboard is a second place it can leak from.
- **Cron.** Not set up. `checkout.js` has a `scheduled()` handler that calls
  `sweepOldEvents`; add `[triggers] crons = ["17 4 * * *"]` to `wrangler.toml`
  when the `webhook_events` table starts mattering.

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
   is what makes that survivable, and that migration is now done — no function
   remains on the money path. Still worth confirming the plan and putting a card
   on file: a paused project still takes the static site down, CMS saves
   included.

## 7. Questions that were open, and where they landed

- **Where do gift-card codes get _created_?** _Answered._ In
  `workers/routes/gift-cards.js`, at 12 symbols over a 32-symbol alphabet with no
  modulo bias, derived per (session, unit) under `STRIPE_WEBHOOK_SECRET` so a
  webhook redelivery re-derives the same string. See §4.3.
- **RPC or fetch?** _Still open, deliberately._ The Durable Objects are addressed
  over `fetch` because that is what lets `scripts/worker-state.test.js` drive
  real instances with plain `node` — `cloudflare:workers`' `DurableObject` base
  class cannot be imported outside the runtime. Switching to RPC is a small
  change and slightly cheaper per call; it would cost the ability to test the
  ledger without miniflare. Not worth it at this volume.
- **Points earning rate and expiry.** _Still open, and it is what keeps loyalty
  unwired._ `loyalty.js` stores whatever is credited; nothing decides how many
  points an order earns or whether they expire. Deciding that is the first step
  of closing C-1 properly (§4.5).
- **Do reservations need to survive a code change?** _Still open, still
  theoretical._ A card's Durable Object is addressed by its code, so reissuing a
  card under a new code does not carry its balance across. Codes are immutable
  today and nothing reissues them.
- **What happens to a hold nobody resolves?** _Answered._ The object's alarm
  releases anything older than 24 hours, which is a Stripe session's maximum
  life. `checkout.session.expired` normally gets there first; the alarm is the
  backstop for an event that never arrives.
