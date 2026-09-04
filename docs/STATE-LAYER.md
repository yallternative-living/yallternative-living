# The state layer — architecture, and the routes built on it

**Status: phase B done, plus the retention layer.** The bindings are live in
`workers/wrangler.toml`, the Worker exports the Durable Object classes, and gift
cards, the Stripe webhook, order status and restock all run on this layer.
`loyalty.js` and `magic-link.js` are no longer unwired: points are credited from
`checkout.session.completed`, paid out automatically at a threshold, and read
back through a token-gated route (§4.5-4.7). Six additive tables and one hourly
cron carry the post-purchase email sequence, abandoned-checkout recovery, the
birthday club and the welcome code (§4.6).

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
| `/api/unsubscribe`       | `?t=<unsub_id>.<sig>`                       | `200 {success:true, message}` — the same answer whether or not the address was known; `400 {error}` for a token that does not verify; `429`; `503` with no `STATE_DB`                                                                                                          |
| `/api/welcome-code`      | `{email}`                                   | `200 {configured:true, code, expiresAt}`; `200 {configured:false}` when no coupon id is set; `400 {error}` for an unusable address; `429`; `502` when Stripe refuses; `503` with no `STATE_DB`                                                                                 |
| `/api/birthday-club`     | `{email, birthday}` (`MM/DD`) or a form post | `200 {success:true, message}`; `400 {error}` for a bad address or anything that is not MM/DD (a year is always refused); `429`; `503`. A **form** post gets `303` to `/thank-you.html?birthday=saved` instead of JSON                                                          |
| `/api/loyalty-balance`   | `{email, token}`                            | `200 {balance, threshold, rewardCents, pointsToReward}`; `403 {error}` for a missing, expired, wrong-purpose or wrong-address token — one message for all four; `429`; `503`                                                                                                   |

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
  nothing. The birthday-club honeypot behaves identically.
- **`/api/loyalty-balance` never answers on an email alone.** The signed
  `points` token from a post-purchase email is required, and it must have been
  minted for the address in the request. This is audit finding C-1 in read-only
  form: knowing somebody's address is not authorisation to see what they spent.
- **No unsubscribe URL contains an address.** The token is
  `<unsub_id>.<signature>` where `unsub_id` is an HMAC of the address under
  `MAGIC_LINK_SECRET`, truncated — one-way, unguessable, and resolved back to an
  address only by `email_contacts` inside the Worker. The signature is checked
  before any database read, so the endpoint is not an enumeration oracle.
- **The birthday club stores `MM-DD` and nothing else.** There is no year in the
  form, no column that could hold one, and the route refuses `1990-06-14`.

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

### 4.5 Previously unwired, now wired

Three things this document used to list as "deliberately unwired" are live:

- **`workers/state/loyalty.js`** now earns and pays out. The earning rate comes
  from `content.json`'s `site.loyaltyPointsPerDollar` — the same CMS field the
  product-card badge reads, so the badge and the credit cannot disagree — and
  the credit happens only from a verified `checkout.session.completed`, keyed on
  the order id. See §4.7.
- **`workers/state/magic-link.js`** signs the `points` tokens the
  `/api/loyalty-balance` route requires, and `signToken` gained an explicit
  `maxTtlSeconds` so a long-lived read-only link can be minted without raising
  the 24h ceiling that the order-status flow relies on.
- **The cron.** `wrangler.toml` now has `[triggers] crons = ["7 * * * *"]` and
  `scheduled()` runs five jobs (§4.6).

### 4.6 The retention layer

Six additive tables (schema version 2) and one hourly cron.

| Table               | Holds                                                                 | Idempotency                        |
| ------------------- | --------------------------------------------------------------------- | ---------------------------------- |
| `order_signals`     | one row per paid order: address, address hash, product ids, categories, timestamp | PK on the Stripe session id |
| `email_queue`       | scheduled sends: kind, address, JSON payload, `send_after`, status, attempts | PK is `<kind>:<subject>`      |
| `email_suppression` | opted-out addresses, honoured by every marketing send                  | PK on the address                  |
| `email_contacts`    | `unsub_id` → address, so an unsubscribe URL can carry no PII           | PK on `unsub_id`                   |
| `birthday_club`     | address, `MM-DD`, consent timestamp, source                            | PK on the address                  |
| `welcome_codes`     | the one Promotion Code minted per subscriber                           | PK on the address                  |

`order_signals` is NOT a copy of the order. Stripe stays the system of record
(§2); this is metadata *about* an order, held so a day-12 email can be written
without calling Stripe back for data that may have been redacted by then.

**Why a D1 queue and not one Durable Object alarm per order.** Both work. The
sends are day-scale, so minute precision buys nothing; a DO-per-order costs one
object and one alarm per order whose state cannot be listed, audited or replayed
by hand; and a dropped alarm is silent, while an undrained row is visible to
`wrangler d1 execute "SELECT * FROM email_queue WHERE status = 'pending'"`. The
`scheduled()` handler already existed for the webhook sweep, so this is a query,
not a subsystem.

**The cron (`crons = ["7 * * * *"]`)** runs, in order: `sweepOldEvents`,
`sweepBurnedTokens`, `sweepEmailQueue`, `runBirthdayClub`, `drainEmailQueue`.
Every step is idempotent and independently try/caught — a birthday that cannot
be minted must not stop the day-2 emails. Hourly rather than daily because the
recovery mail wants to go out within the hour and an hourly job retries itself.

**Every marketing send** goes through `sendMarketingEmail`, which refuses a
suppressed address (checked at SEND time, not enqueue time, so an unsubscribe on
day 3 stops a review request queued on day 0), adds `List-Unsubscribe` and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), and adds the
visible opt-out line. With no `MAGIC_LINK_SECRET` it sends **nothing**: an email
whose opt-out link cannot be signed must not go out.

**Review requests are never incentivised**, conditionally or otherwise. The FTC
rule (16 CFR 465, effective 2024-10-21) bans conditioning a reward on the review
being positive; offering nothing at all is the version that stays clean at this
volume, and the template says "good, bad, or 'it's fine, I guess'" on purpose.

### 4.7 The retention sequence, event by event

| Trigger                                                      | What happens                                                                                                                                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/checkout` creates a session                             | `after_expiration[recovery][enabled]=true`, `consent_collection[promotions]=auto`, `consent_collection[terms_of_service]=required` + linked terms text, and `retention_product_ids` / `retention_categories` in metadata |
| `checkout.session.completed`                                  | one `order_signals` row; queue "how to use your …" and a review request, both counted from DISPATCH — assumed 3 days out, then +4 days (CMS-adjustable) and +7 days (apparel, gift cards) or +12 days (everything else, mixed orders included). A gift-card-only order assumes no dispatch delay |
| cron, hourly (`runShipNoticeSweep`)                          | list the last 45 days of PaymentIntents; for each one whose `fulfillment_status` reads shipped and is not yet in `order_emails`, send the ship notice, then re-anchor both queued rows on the real dispatch moment. No Stripe event fires for a metadata edit |
| `checkout.session.completed`                                  | credit points on `amount_subtotal` (goods, not postage) at the CMS rate, keyed on the order id; if the balance reaches `LOYALTY_REDEEM_THRESHOLD`, debit it atomically, mint a single-use code and queue the email |
| `checkout.session.expired`                                    | queue the recovery email at +45 minutes — **only** with a recovery URL, an address AND `consent.promotions === "opt_in"`                                                              |
| cron, 9am America/New_York                                    | mint and queue a single-use $5 code for every `birthday_club` member whose `MM-DD` is today, idempotent per member per year                                                            |
| `POST /api/unsubscribe`                                       | add the address to `email_suppression`; every queued send for it is skipped, not retried                                                                                               |

**Loyalty payout order of operations.** The debit runs FIRST, because `debit()`
is the only atomic step — its balance check lives inside the INSERT, so two
concurrent webhooks cannot both pay out. Minting after it is safe to retry: a
repeated debit reports `duplicate` rather than spending again, and the Stripe
idempotency key returns the SAME promotion code, so a webhook that dies between
the debit and the email is fully recovered by Stripe's redelivery. A mint that
Stripe refuses **throws**, which is what puts the event back in the retry loop
rather than silently swallowing spent points.

### 4.8 Revenue reporting (schema version 5)

One additive table, `analytics_sends`, and one step in the Stripe webhook.

| Table             | Holds                                                   | Idempotency                |
| ----------------- | ------------------------------------------------------- | -------------------------- |
| `analytics_sends` | one row per thing reported to analytics from the server | PK on `<kind>:<stripe id>` |

On `checkout.session.completed` with `payment_status === "paid"`,
`workers/routes/stripe-webhook.js` books the order's revenue in Umami — an
`Order Paid` event carrying `{ revenue, currency }` and nothing else, built by
`workers/routes/analytics.js` from `amount_total` on the session Stripe itself
says was paid. The browser used to do this and still fires `Purchase` as the
funnel's last step, but with **no properties**: a client-side figure misses
every shopper who closes the tab on the Stripe redirect or blocks the tracker,
and keeping both would double-count everyone else.

**Why not the `webhook_events` claim.** That claim is _released_ when a handler
fails, so Stripe's retry can re-run every step — correct, because every step is
idempotent. An analytics send is not idempotent at the far end: Umami would book
the same money twice and the Revenue report would overstate the shop's takings
while looking perfectly plausible. So `analytics_sends` is keyed on the Checkout
Session id, is taken _before_ the request, and is never released once the request
has gone out. It is released in exactly one case — the send was never attempted
because `UMAMI_WEBSITE_ID` is unset — so configuring the id later and replaying
the event still books the order.

**What must never happen.** A failure here must not reach the webhook's response.
A non-2xx makes Stripe redeliver, which re-runs the money path, and no dashboard
number is worth that. The send is fire-and-forget behind `ctx.waitUntil` with a
3-second `AbortController` timeout, every failure is logged rather than thrown,
and the call site is deliberately outside the `failures` array the other steps
push to.

**No personal data leaves the Worker.** Not the buyer's address, not their name,
and not the Stripe session id — that id is the token `/api/order-summary` looks
an order up with, and it is used here only as the local claim key. The event's
`hostname` and `url` are constants (`yallternativeliving.com`,
`/thank-you.html`) so it lands on the same website row the browser's events do.

**A 100%-gift-card order is deliberately not booked.** Stripe reports it as
`payment_status: "no_payment_required"`; nothing was captured, and the card
itself was already counted as revenue when it was bought.

**Two operational gotchas, both of which fail silently.**

1. `UMAMI_WEBSITE_ID` is a `[vars]` entry in `workers/wrangler.toml`, duplicated
   from `assets/data/content.json` → `site.umamiWebsiteId` on purpose: the Worker
   has no filesystem and must not depend on the site build.
   `scripts/worker-analytics.test.js` fails when the two disagree.
2. Umami runs every collection request through the npm `isbot` package and
   answers `200 {"beep":"boop"}` — recording nothing — for a User-Agent it
   classifies as a bot. Umami's own documented example, `Mozilla/5.0 (Server)`,
   _is_ classified as a bot. The string in `analytics.js` was chosen by testing
   candidates against the real package, and the test suite re-checks it on every
   run so an `isbot` update cannot switch revenue reporting off quietly.
   `sendToUmami` also reads the response body and reports `bot-filtered` rather
   than calling a `beep:boop` a success.

Swept after 90 days by the hourly cron, so it is not the one table in the schema
that grows forever.

### 4.9 The ship notice (schema version 6)

One additive table, `order_emails`, and one more hourly cron job.

| Table          | Holds                                                        | Idempotency                |
| -------------- | ------------------------------------------------------------ | -------------------------- |
| `order_emails` | one row per transactional order email already delivered      | PK on `<kind>:<stripe id>` |

The shop marks an order shipped by writing `fulfillment_status` (and usually
`tracking_url`) onto the order's **PaymentIntent** — the same three keys
`/api/order-status` has always read back. That write fires **no Stripe event**
(there is no `payment_intent.updated`; the eight `payment_intent.*` events are
`created`, `succeeded`, `payment_failed`, `canceled`, `processing`,
`requires_action`, `amount_capturable_updated` and `partially_funded`), so
`runShipNoticeSweep` in `workers/routes/ship-notice.js` runs from the hourly
cron, lists the last 45 days of PaymentIntents, and turns every newly shipped
one into the "your order is on its way" email. Before it, the fulfilment metadata was
readable only by a customer who came back to order-status.html unprompted with
their `cs_…` reference in hand, while thank-you.html promised "we'll follow up
once it ships" and the returns policy told them to quote a tracking number
nothing had sent them.

**It is transactional, so it does not go through the queue.** Everything
`drainEmailQueue` touches is a marketing send by construction — suppression
check, `List-Unsubscribe`, visible opt-out line. A tracking number is owed to
someone who unsubscribed, so the notice goes out through `sendEmail` directly
rather than through the marketing drain and its footer.

**Why not the `webhook_events` claim.** That one is keyed on an _event_, and
there is no event here. The sweep sees the same shipped order on every hourly
pass for 45 days; `order_emails` is keyed on the PaymentIntent, so every pass
after the first does nothing — and costs one D1 read, not a Stripe call, because
the "already sent?" check runs before the session lookup.

**Why not `analytics_sends` either.** That claim is taken _before_ the side
effect and never released, because an overstated revenue figure is worse than a
missing one. Here the trade runs the other way: a customer who is never told
their parcel shipped is worse than a rare duplicate. So the row is written
_after_ Resend accepts the message, a refusal records nothing so the next hourly
pass simply tries again, and the Resend `Idempotency-Key` (`ship-notice-<pi id>`)
closes the only window that leaves — two passes in flight at once.

**It also fixes the post-purchase clock.** The how-to-use and review emails are
about a thing somebody is holding, but they were scheduled from `placed_at`:
"how to get the most out of your salve" landed 2.5 days after checkout while the
shipping policy still promised dispatch within 1–3 _business_ days, so a Friday
order was asked about a jar that had not been packed. They are now measured from
dispatch — assumed at 3 days (the top of that stated window) when the order is
queued, then corrected by `reanchorOrderSequence` the moment the ship notice
goes out. A gift-card-only order skips the assumption entirely: it was delivered
by the same webhook that recorded it.

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
npx wrangler secret put MAGIC_LINK_SECRET      # 32+ random chars; signs unsubscribe + points links
# optional vars: RESTOCK_NOTIFY_EMAIL, GIFT_CARD_FROM_EMAIL, RETENTION_FROM_EMAIL
# retention vars: STRIPE_WELCOME_COUPON_ID, STRIPE_BIRTHDAY_COUPON_ID,
#                 STRIPE_LOYALTY_COUPON_ID, LOYALTY_REDEEM_THRESHOLD (100),
#                 LOYALTY_REWARD_CENTS (500) — see workers/README.md §2b
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
- **Netlify.** The proxy rule and the `BLOCKED_PATHS` 404 rules are generated by
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
