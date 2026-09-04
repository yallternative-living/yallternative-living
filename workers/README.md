# Cloudflare Workers (checkout + CMS login + forms)

`checkout.js` is the live backend for **the entire money path**. The on-site
cart (`assets/js/cart.js`) POSTs to it and gets back a Stripe Checkout URL, and
four more endpoints that used to be Netlify Functions now live behind the same
router:

| Route                         | What it does                                                          |
| ----------------------------- | --------------------------------------------------------------------- |
| `POST /api/checkout`          | creates a Stripe Checkout Session; applies a gift card if one is sent |
| `POST /api/gift-card-balance` | `{code}` -> the balance on the ledger, rate-limited 10/min per IP     |
| `POST /api/stripe-webhook`    | Stripe events: issues cards, commits/releases holds, restores refunds |
| `POST /api/order-status`      | `{sessionId, email}` -> a real order, rate-limited 5/min per IP       |
| `POST /api/restock`           | `{email, product}` -> emails the shop                                 |
| `POST /api/safety-report`     | a reaction report (MoCRA) -> a three-year D1 row + two emails           |
| `GET /api/gift-note`          | the owner's printable 4x6 gift note for an order (signed link from the order email) |
| `POST /api/order-summary`     | `{sessionId}` -> the settled totals for the thank-you page            |
| `POST /api/unsubscribe`       | `?t=<token>` -> opts an address out of every marketing send           |
| `POST /api/welcome-code`      | `{email}` -> a single-use Stripe Promotion Code for a new subscriber  |
| `POST /api/birthday-club`     | `{email, birthday}` (MM/DD, never a year) -> stored with consent time |
| `POST /api/loyalty-balance`   | `{email, token}` -> Alt-Points balance; the token is REQUIRED         |

Everything else 404s as JSON. Every response is `Cache-Control: no-store`, and
CORS is the apex + www allowlist with `Vary: Origin`. Snipcart is fully removed
(see `docs/STRIPE-MIGRATION.md`) -- this Worker is what replaced it, and it needs
to actually be deployed (with real Stripe keys) before checkout works.

The handlers live in `workers/routes/`; the state they sit on -- the gift-card
ledger, the exactly-once webhook claim, the rate-limit counters -- lives in
`workers/state/`. `docs/STATE-LAYER.md` explains why that layer looks the way it
does and what it costs on the free plan.

**`netlify/functions/` no longer exists.** Its four handlers moved here, because
the state above lives in Cloudflare Durable Objects and D1 which a Netlify
Function cannot reach, and because audit H-23 found the Netlify free plan pauses
_every_ project at its monthly credit cap -- the Stripe webhook included. The
four old URLs answer `410 Gone` at the edge (see the rules in
`scripts/build-security-headers.js`). `redeem-points` was not ported at all:
audit C-1 found it minted real, cash-like store credit for anyone who could POST
to it, and there is no server-side points ledger for a rebuilt version to spend
from.

`auth/sveltia-auth.js` is the **CMS sign-in service** -- the permanent "Sign in
with GitHub" button for the Sveltia CMS product editor at `/admin`. It replaces
Netlify's deprecated "Git Gateway / OAuth" login, so `/admin` depends on nothing
from Netlify. It's its own separate Worker in the top-level `cms-auth/` folder
(see the section below). Optional to deploy: Savanna can also log in immediately
with a token ("Sign in with Token") and set this up later.

`submit-form.js` is still **optional** -- the contact/review forms currently post
to Formspree directly, and this Worker is only worth deploying if you want that
mail coming from your own domain or you outgrow Formspree's free tier.

Both started as corrected versions of the drafts from `sota_research_2026.md`,
which had real security bugs (wildcard CORS, unescaped email HTML, no quantity
caps, no server-side price validation). See the header comment in each file.

**One Stripe API version, one file.** It used to be one value copied into four
files that read and wrote the same Stripe objects, so bumping it in one and not
the others meant one side sent a shape the other could not parse. It is pinned
once now, in `workers/routes/stripe.js`, and every caller imports it.

---

## Why bother — the money argument

**Snipcart** charges **2% per transaction _or_ a $20/month minimum**, whichever
is higher, for shops doing under $1,000/month in sales. For a small-batch shop,
that's effectively **$240/year of fixed overhead** on top of the payment
gateway's own fees.

**Stripe** has **no monthly fee** — just the standard per-transaction cost
(2.9% + 30¢). So at low volume, moving checkout to Stripe removes the $20/month
floor entirely and you only pay when you actually sell something. That's the
"same sales, less money" win.

Two ways to do it:

| Option                            | Server needed?                                | Best for                                                                                                                              |
| --------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Stripe Payment Links**          | None (static URLs)                            | Simplest. One link per product/price, created in the Stripe dashboard. No cart, no Worker. Good if most orders are single items.      |
| **Stripe Checkout + this Worker** | 1 Cloudflare Worker (free tier: 100k req/day) | Keeps a real multi-item cart. `checkout.js` validates prices server-side against `products.json` and hands Stripe a Checkout Session. |

> Note: the SOTA report labeled its snippet "Payment Links" but the code was
> actually Checkout Sessions — two different Stripe products. `checkout.js` here
> is Checkout Sessions (the cart path). For true Payment Links you don't need a
> Worker at all.

---

## Deploying `checkout.js`

Savanna creates the Cloudflare account herself and invites Steven in
as a Member (see `docs/SETUP-GUIDE.md` Step 3B) -- account ownership
stays hers, but the actual deploy work below is still Steven's job,
done from inside her account. So the choice below is purely about
which method is best for _Steven doing it_, not about avoiding a
terminal for someone who was never going to run these commands
regardless.

**Option A (Workers Builds) is what this repo is now set up for** -- see the
committed `workers/wrangler.toml`. The reasoning below is left intact because
it is still the honest trade-off: Option B was written up as the safer default
for this specific file -- it's the long-established, well-tested path, and
this Worker touches Stripe secret keys and real payments, where
favoring the most mature deploy method over the newest one is the right
trade-off. Option A is documented as a legitimate alternative, not a
downgrade -- reach for it if you'd genuinely rather never run
`wrangler deploy` again after initial setup, just go in with eyes open
about its beta status.

### Option B -- Wrangler CLI (fallback: well-tested, long track record)

> Use this if Workers Builds misbehaves, or for a one-off deploy without
> waiting on a push. It reads the same committed `wrangler.toml`, so the two
> paths cannot drift apart.

1. `npm i -g wrangler` and `wrangler login`.
2. `cp wrangler.toml.example wrangler.toml`, confirm `SITE_ORIGIN`.
3. `wrangler secret put STRIPE_SECRET_KEY` (use a **restricted** key with
   Checkout Sessions + Coupons + Promotion Codes **write**, since
   `fulfill-gift-card.js` creates those, plus Customers write and Tax
   Settings **read** -- the Worker pins pickup orders to a market address
   via a Customer, and reads Tax Settings to know when to start charging
   sales tax. Without Tax read it just never enables tax; nothing breaks
   loudly, so it's an easy one to miss).
4. `wrangler deploy`. Leave `STRIPE_TAX_ENABLED` unset -- tax turns itself
   on once Stripe Tax is activated in the Dashboard. See DEVELOPMENT.md
   section 8.
5. Optionally point a route at it (`yallternativeliving.com/api/*`). Not
   required today: the site reaches the Worker through Netlify's `/api/*`
   proxy, so `workers_dev` stays on and no route is needed. A real route
   removes that hop, but it needs Cloudflare running the domain's DNS, and DNS
   lives at Netlify.
6. Any future change to `checkout.js` needs step 4 run again by hand --
   worth knowing going in, since that's the main thing Option A trades
   away the beta risk to avoid.

### Option A -- Cloudflare Workers Builds (dashboard-only, open beta) -- **this is the configured path**

> **Step 1 is already done.** `workers/wrangler.toml` is committed, and
> `npx wrangler deploy --dry-run` builds it clean (19 KiB upload, `SITE_ORIGIN`
> bound). Everything left is dashboard clicking -- steps 2-4 below.

Cloudflare's own git-integration feature (Workers Builds) auto-deploys
on every push, the same way Netlify already does for the rest of the
site -- confirmed to exist and to support a subdirectory root (this repo
isn't a single-Worker repo; `checkout.js` lives under `workers/`) via
Cloudflare's current docs as of mid-2026. Two things worth knowing
before picking this over Option B: Cloudflare's own docs still label
Workers Builds "open beta," not GA, and this exact flow has not been
run against this project's real Cloudflare/GitHub accounts -- treat it
as "try this," not a guarantee.

1. ~~Create a real `wrangler.toml` from `wrangler.toml.example` and commit
   it.~~ **Done** -- see `workers/wrangler.toml`, whose header comment
   repeats the dashboard steps below so they're findable from the file
   itself.
2. Cloudflare dashboard -> **Workers & Pages -> Create -> Import a
   repository** (button wording may have shifted -- look for anything
   offering to connect a GitHub repo) -> authorize GitHub -> select this
   repo -> set the project root to `workers`.
3. **Settings -> Variables and Secrets -> Add** -> `STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET` and `RESEND_API_KEY`, type **Secret** (same
   restricted-key guidance as Option B step 3; see "Turning the state layer on"
   below for what each one is for).
4. **Settings -> Domains & Routes.** Optional -- see Option B step 5. If you do
   add a route, it is `yallternativeliving.com/api/*`, not just
   `/api/checkout`: the Worker answers five paths now.
5. Every future push to `checkout.js` redeploys automatically -- no
   step 4 of Option B (`wrangler deploy`) ever needs to run by hand
   again.

If anything in Cloudflare's dashboard doesn't match this (menu names
move around), fall back to Option B.

### A note on "best practice" here

Cloudflare's own best-practices docs are explicit that manual `wrangler
deploy` from someone's laptop shouldn't be the long-term answer -- some
form of CI/CD should own it. Their most heavily-documented path for that
is GitHub Actions + the official `wrangler-action` (a third option, not
written up here since it needs a hand-authored workflow file and a
Cloudflare API token stored as a GitHub secret -- more setup than either
option above, and overkill for a single small Worker). Workers Builds
(Option A) is Cloudflare's own answer for "I want CI/CD but don't want
to write a workflow file" -- a real, reasonable choice, just not the
one with the longest track record, which is why Option B leads above
for this particular file. Also skipped on purpose given this project's
size: a separate staging environment with its own routes/secrets
(Cloudflare's textbook recommendation for production Workers) --
reasonable to add later if this ever outgrows "one small business's
checkout endpoint," not worth the extra accounts/complexity today.

Either option: that's the whole client-side contract -- `assets/js/cart.js`
already POSTs `{ items: [{ id, qty, variant }] }` here and redirects the
browser to whatever Checkout URL comes back -- no further client changes
needed.

Security notes already handled in the code: CORS is locked to your origins,
prices are re-derived from `products.json` (client prices are ignored),
quantities are integer-clamped 1–99, and both `products` and `bundles` are
searched.

---

## Sign-in Worker (CMS login) — `../cms-auth/sveltia-auth.js`

This is the **permanent "Sign in with GitHub" button** for the Sveltia CMS
product editor at `/admin` (DEVELOPMENT.md section 20, Option B). It's the
modern replacement for Netlify's deprecated "Git Gateway / OAuth" login —
`/admin` no longer depends on Netlify for anything.

It's a **separate Worker** from checkout, in its own **top-level `cms-auth/`
folder** (not under `workers/`) with its own committed `wrangler.toml`, kept
apart on purpose: the checkout Worker holds the Stripe secret and handles real
payments, so the CMS login stays isolated from it. It also _has_ to live outside
`workers/` — that folder is the checkout Worker's Workers Builds root, and a
second `wrangler.toml` inside it breaks the checkout build. Nothing secret is
committed here either — the GitHub client secret only ever lives as a Cloudflare
Secret.

> **Alternative that needs none of this:** Savanna can log in _today_ with
> **"Sign in with Token"** on the `/admin` screen (a GitHub fine-grained token,
> zero infrastructure — SETUP-GUIDE.md Step 9 / DEVELOPMENT.md section 20
> Option A). This Worker is the nicer, permanent login you graduate to.

**Setup (once):**

1. **GitHub OAuth App** — GitHub → **Settings → Developer settings → OAuth
   Apps → New OAuth App** (the short _OAuth App_ form, **not** "GitHub App").
   Homepage URL `https://yallternativeliving.com`. Copy the **Client ID**,
   generate + copy a **Client Secret**. Set the **Authorization callback URL**
   after step 2 to `<this-Worker-URL>/callback`.
2. **Deploy `cms-auth/`** — same two paths as checkout above:
   - **Workers Builds (dashboard):** Workers & Pages → Create → Import a
     repository → this repo, project root **`cms-auth`** (checkout's root
     is `workers`; each Worker is its own Workers Builds project). Redeploys on
     every push, no `wrangler deploy` by hand.
   - **Wrangler CLI:** `cd cms-auth && wrangler deploy`.

   Either way, `wrangler deploy --dry-run` builds it clean first if you want to
   check. Cloudflare then shows the Worker URL, e.g.
   `https://yallternative-cms-auth.<subdomain>.workers.dev`.

3. **Secrets** — this Worker → **Settings → Variables and Secrets** → add
   `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (type **Secret**) from step 1.
   `ALLOWED_DOMAINS` is already set as a plain var in `wrangler.toml` and locks
   token issuance to this site — no other site can point its CMS at this Worker
   and harvest tokens.
4. **Wire the URLs together** — put the Worker URL into `admin/config.yml` as
   `backend.base_url` (replace the `YOUR-SUBDOMAIN` placeholder), and set the
   GitHub OAuth App's callback (step 1) to `<that-URL>/callback`. They must
   match exactly. Commit `config.yml`; `/admin` now shows **Sign in with
   GitHub**.

Security notes already handled in the code: a random per-login CSRF token in an
HttpOnly cookie is checked on callback; the access token is only `postMessage`d
to a window whose origin matches `ALLOWED_DOMAINS`; the callback page is
`Cache-Control: no-store`; and the client secret is read only from a Cloudflare
Secret (never committed).

---

## Deploying `submit-form.js`

1. Verify your sending domain in **Resend** and create an API key.
   Free tier: 3,000 emails/month **and** 100/day.
2. Create a **Cloudflare Turnstile** widget (free) — you'll get a site key
   (for the page) and a secret key (for the Worker).
3. Deploy as a second Worker (`name = "yallternative-forms"`,
   `main = "submit-form.js"`) with:
   - vars: `TO_EMAIL`, `FROM_EMAIL`
   - secrets: `RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`
4. On the form: add the Turnstile widget, a hidden `website_hp` honeypot field,
   and POST the form data to the Worker route.

If you keep Formspree, you can ignore this file — it's only worth switching if
you want form mail coming from your own domain, or you outgrow Formspree's free
submission cap.

---

## Turning the state layer on (do this in order)

The Worker deploys from `workers/wrangler.toml` on every push to `main`
(Workers Builds). That file now declares a D1 database whose `database_id` is a
**placeholder**, so **`wrangler deploy` fails until step 1 is done** -- which
would mean the next urgent checkout fix silently never ships. Do step 1 before
the next push.

### 1. Create the D1 database and paste its id

```bash
npx wrangler d1 create yallternative-state
# -> prints database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Paste that id over `REPLACE_ME_WITH_THE_ID_FROM_WRANGLER_D1_CREATE` in
`workers/wrangler.toml`, then load the schema:

```bash
npx wrangler d1 execute yallternative-state --remote --file=workers/schema.sql
```

(The Worker also applies the same statements itself at the first webhook
request -- `workers/state/migrations.js` -- so this is belt and braces, not the
only path.)

The Durable Object bindings need no setup: `checkout.js` exports
`GiftCardLedger` and `RateLimitCounter`, and the `new_sqlite_classes` migration
in `wrangler.toml` creates them on first deploy. SQLite-backed Durable Objects
are the ones included on the free plan; `new_classes` (the older key-value
backend) is paid-only and cannot be changed after the fact.

### 2. Verify the domain in Resend

Resend.com -> Domains -> Add Domain -> enter `yallternativeliving.com` -> add the
DNS records it shows (a couple of TXT records, one MX) wherever this domain's DNS
is managed (Netlify, since Step 2B of `docs/SETUP-GUIDE.md` pointed the
nameservers there) -> click Verify.

This is NOT optional. The Worker sends `from: gifts@yallternativeliving.com`, and
Resend silently rejects sends from an unverified domain: the buyer's purchase
completes, the recipient's gift card never arrives, and nothing surfaces that to
a human. Confirm it reads "Verified" before relying on this in production.

### 2b. The retention layer (post-purchase email, birthdays, loyalty)

Everything in this section is optional in the sense that checkout works without
it, and **defined** when it is unset: an unset coupon id means the route reports
`configured: false` and the job logs and does nothing, rather than minting codes
against something that is not there.

**Routes** (all four in `workers/routes/retention.js`, all `POST`, all
rate-limited by IP, all 503 without `STATE_DB`):

| Route                       | Body                     | Notes                                                                                                        |
| --------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `POST /api/unsubscribe`     | token in `?t=`           | RFC 8058 one-click. The token is an HMAC of the address -- **no PII in the URL**. Also accepts `{token}` JSON. |
| `POST /api/welcome-code`    | `{email}`                | Mints one Promotion Code per address (`max_redemptions: 1`, first-order only, 45-day expiry).                 |
| `POST /api/birthday-club`   | `{email, birthday}`      | `MM/DD` only. Accepts a plain form post too and answers it with a 303 back to `thank-you.html`.               |
| `POST /api/loyalty-balance` | `{email, token}`         | The signed `points` token from a post-purchase email. A balance is never readable by email alone.            |

### 2c. The MoCRA adverse-event route

`POST /api/safety-report` backs `safety.html`, the page behind the
`https://yallternativeliving.com/safety` URL printed on the packaging. MoCRA
(21 U.S.C. 364a, FD&C Act section 609(a)) requires the label to carry a contact
through which a consumer can report an adverse event; this is it.

| Thing              | Where it goes                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| The report         | one row in the D1 table `adverse_events` (schema version 3), kept at least three years. **Needs `STATE_DB`; answers 503 without it.** |
| The owner's copy   | Resend, to `SAFETY_REPORT_EMAIL` -> `RESTOCK_NOTIFY_EMAIL` -> `contact@yallternativeliving.com`.    |
| The reporter's copy| Resend, an acknowledgement carrying the reference only.                                            |

- `serious` is computed on the server from the outcome checkboxes, never taken
  from the client. When it is set the owner's subject is prefixed `SERIOUS -- `
  and the first line of the mail names the **15-business-day** FDA clock and
  Form FDA 3500A (MedWatch).
- The reference is `YL-AE-XXXX-XXXX`, the same Crockford base32 alphabet the
  gift-card codes use.
- Accepts a JSON fetch or a plain form post (303 back to `safety.html` with the
  reference in the query), so the page works with JavaScript off.
- Rate-limited 5/min per IP; a filled `website_hp` honeypot gets the success
  shape and writes nothing.
- **The row is the record.** D1 is written first; if that fails the reporter is
  told the report did not go through. If Resend then refuses, the caller still
  gets `{ok: true}` and the reference -- the regulatory record exists -- and the
  refusal is logged with the reference and nothing else. The description, name,
  address and phone never reach a log line.
- **Rows are kept for at least three years and nothing sweeps them.** That is
  MoCRA's small-business retention period (section 612: under $1M average gross
  annual sales over the prior three years). **If that three-year average ever
  crosses $1M the period becomes six years** -- change `RECORD_RETENTION_YEARS`
  in `routes/safety-report.js`, the note on the table in `schema.sql`, the copy
  on `safety.html` and the paragraph in `privacy.html` together. It is a floor,
  not a purge date: the cron in `checkout.js` deletes from `webhook_events`,
  `burned_tokens` and `email_queue`, and `adverse_events` must never be added to
  that list.

**Tables** (`workers/schema.sql`, applied by `workers/state/migrations.js`):
`order_signals`, `email_queue`, `email_suppression`, `email_contacts`,
`birthday_club`, `welcome_codes`. See `docs/STATE-LAYER.md` §4.6.

**Stripe coupons to create by hand** (Dashboard -> Products -> Coupons). These
are *coupons*, not codes: one coupon backs unlimited single-use Promotion Codes,
and the codes are what customers actually type.

| Coupon              | Set the id in            | Used by                                    |
| ------------------- | ------------------------ | ------------------------------------------ |
| 10% off             | `STRIPE_WELCOME_COUPON_ID`  | `POST /api/welcome-code`                |
| $5.00 off (USD)     | `STRIPE_BIRTHDAY_COUPON_ID` | the birthday cron                       |
| $5.00 off (USD)     | `STRIPE_LOYALTY_COUPON_ID`  | loyalty payouts; falls back to the birthday coupon |

**Vars** (`[vars]` in `workers/wrangler.toml`, none of them secret):

| Var                        | Default | What it does                                                        |
| -------------------------- | ------- | ------------------------------------------------------------------- |
| `STRIPE_WELCOME_COUPON_ID` | unset   | Unset -> `/api/welcome-code` answers `configured: false` and `welcome.html` falls back to the CMS `site.welcomeCode`. That fallback is the ONLY remaining use of that field. |
| `STRIPE_BIRTHDAY_COUPON_ID`| unset   | Unset -> the birthday cron logs and mints nothing.                  |
| `STRIPE_LOYALTY_COUPON_ID` | falls back to the birthday coupon | Unset with no birthday coupon -> points accrue but never pay out. |
| `LOYALTY_REDEEM_THRESHOLD` | `100`   | Points that trigger an automatic payout.                            |
| `LOYALTY_REWARD_CENTS`     | `500`   | What a payout is worth. Must match the coupon's own amount.         |
| `RETENTION_FROM_EMAIL`     | falls back to `GIFT_CARD_FROM_EMAIL` | Verified Resend sender for the retention sends. |
| `SAFETY_REPORT_EMAIL`      | falls back to `RESTOCK_NOTIFY_EMAIL`, then `contact@yallternativeliving.com` | Where MoCRA reaction reports are emailed. |
| `UMAMI_WEBSITE_ID`         | set (same value as the CMS) | The Umami website the webhook books each paid order's revenue against ("Order Paid" — `routes/analytics.js`). Unset -> the webhook logs once and books nothing; the site's own page views are unaffected. |

`UMAMI_WEBSITE_ID` is the one var that is deliberately duplicated from the site
(`assets/data/content.json` → `site.umamiWebsiteId`). The Worker has no
filesystem and no access to the build, and revenue reporting that stopped
because a static build changed would be the worst kind of failure — so it is
pinned here and `scripts/worker-analytics.test.js` fails when the two disagree.
It is an id, not a secret: it is on every page of the site in the tracker tag.

Points **per dollar** is deliberately NOT a var: it comes from
`assets/data/content.json`'s `site.loyaltyPointsPerDollar`, the same CMS field
the product-card badge reads, so the badge and the credit cannot disagree.

**One extra secret: `MAGIC_LINK_SECRET`.** It signs the unsubscribe tokens and
the points-balance tokens. With it unset the Worker sends **no marketing email
at all** -- that is intended, not a bug: an email whose unsubscribe link cannot
be signed is an email that must not go out.

```bash
npx wrangler secret put MAGIC_LINK_SECRET   # 32+ random characters
```

Rotating it invalidates every outstanding unsubscribe and points link. The
suppression list itself is unaffected -- it is keyed on the address, not the
token -- but old links stop resolving, so rotate only when you mean to.

**The cron.** `workers/wrangler.toml` has `[triggers] crons = ["7 * * * *"]`.
One hourly tick runs, in order: the webhook-claim sweep, the burned-token sweep,
the email-queue sweep, the birthday club and the email-queue drain. Hourly
rather than daily because the abandoned-checkout recovery mail wants to go out
within the hour and because an hourly job retries itself; the birthday job is
gated to 9am America/New_York and is idempotent per member per year, so 24 ticks
a day still send exactly one birthday code.

**Stripe webhook events.** The endpoint must be subscribed to
`checkout.session.expired` as well as `checkout.session.completed` -- that is
the event carrying the recovery URL. See step 4.

### 2d. The order digest and the size/scent question

Three automations that hang off orders. None is on the money path: all are
best-effort, each is gated by a CMS switch, and none can stop a checkout.

**The daily order digest** (`workers/routes/order-digest.js`, run from the
hourly cron). One email a day with the pick list: per order, the session id, the
buyer's FIRST NAME and city/state, and every line -- with bundles expanded into
the products inside them and a build-your-own box expanded from the
`custom_box_N` metadata `checkout.js` writes. A gift order carries the signed
`/api/gift-note` print link, a local pickup names the market, and anything that
comes in more than one size or scent with nothing chosen is flagged
`NEEDS SIZE/SCENT CONFIRMATION`.

- **Nothing else is in it.** No email addresses, no street addresses, no
  postcodes, no totals, no gift-card codes, no gift-note text. Stripe stays the
  system of record; the digest is a packing aid.
- **Once a day**, via `claimDaily` in `state/job-state.js` (job `order-digest`),
  at `site.automations.orderDigestHour` in `assets/data/content.json` (default
  7, America/New_York, editable in `/admin`). 24 ticks send one email.
- **Never twice**: the query window is 26 hours so a missed tick recovers, and
  the newest session id of each run is kept in `job_state` under
  `order-digest-last`, which is where the next run stops.
- **Off** when `site.enableOrderDigest` is `false` -- then it does not even call
  Stripe, and does not burn the day's claim.
- **A quiet day sends nothing.** Set the var `ORDER_DIGEST_WHEN_EMPTY = "true"`
  if you would rather get a "No new orders" note than wonder whether it ran.

**The per-order copy** (`emailOwnerOrderNotice` in `routes/stripe-webhook.js`,
on `checkout.session.completed`). The moment a session is paid (or fully
covered by a gift card), the shop inbox gets one email with what the bench
needs: every line with its quantity, size or scent, unit price and line total;
box contents and gift-set choices from metadata; discount, gift card applied,
shipping and total; the buyer's name and email; the gift note itself (recipient,
sender and message, verbatim); the FULL shipping address, or
`Local pick-up at <market>`; the order date; and the payment's link in the
Stripe Dashboard. Subject: `New order $30 -- 1× <first line> +N more`.

- **Not on the money path.** Only the checks that need no network run before
  the webhook answers; the rest is handed to `ctx.waitUntil`, like the revenue
  report. The event carries no line items, so the step lists them from
  `/checkout/sessions/{id}/line_items` in pages of 100 under a 5-second
  deadline; if that read fails or times out the email still goes out and says
  the lines are missing, and a list with `has_more` says "+more" rather than
  a wrong count. A Resend refusal is logged and swallowed -- it never makes
  Stripe replay the event. Keyed `owner-order-email-<session id>` at Resend,
  so a redelivery sends one copy.
- **What it prints where.** The address is the one Checkout collected for
  shipping and nothing else -- an all-gift-card order has none and is marked
  `Digital delivery -- no shipping`, never the card's billing address. A
  `pickup_market_rejected` flag from `checkout.js` is called out. Every line
  of a gift message is quoted in the plain-text body, and a buyer name is kept
  to one line, so neither can pose as the real Ship-to block.
- **Off** when `site.enableOrderEmails` is `false` ("Email me each order as
  it's paid" in `/admin`); the other gate is the recipient
  (`ORDER_NOTIFY_EMAIL` -> `RESTOCK_NOTIFY_EMAIL` -> the contact address).

**The size/scent confirmation** (`emailSizeConfirmation` in
`routes/stripe-webhook.js`, on `checkout.session.completed`). A bundle and a
build-your-own box are each ONE line, and neither lets the shopper pick a size:
`checkout.js` only records an option for a plain product line. So when a paid
order contains a bundle or a box whose contents have `variants`, the buyer gets
one email opening with `site.automations.sizeConfirmationIntro`, listing what
needs choosing and its options, with `reply_to` set to the shop address so an
answer arrives as an ordinary reply. It is transactional -- **no unsubscribe
link, no suppression check** -- and keyed `size-confirm-<session id>` at Resend,
so a redelivered webhook asks once. A plain order, or a bundle whose contents
have no variants, gets nothing.

| Var                       | Default | What it does                                                          |
| ------------------------- | ------- | --------------------------------------------------------------------- |
| `ORDER_NOTIFY_EMAIL`      | falls back to `RESTOCK_NOTIFY_EMAIL`, then `contact@yallternativeliving.com` | Where the per-order copy, the digest and the gift-note link go. |
| `ORDER_DIGEST_WHEN_EMPTY` | unset   | `"true"` sends the digest on days with no orders too.                 |

Both read `assets/data/products.json` for names, a bundle's `productIds` and a
product's `variants` -- the same file the shop pages render from, so the pick
list cannot drift from the label. If it is unreachable the digest still goes out
with the Stripe line names unexpanded, and the size question is simply not asked.

### 2e. Restock alerts, low-stock notes, market reminders and the monthly reaction export

Four more jobs the hourly cron runs (`scheduled` in `checkout.js`, after the
order digest). Like the digest, none of them is on the money path: each is gated
by a switch in `assets/data/content.json` (`site.*`, editable under Site
settings in `/admin`), each degrades to one logged line when its secrets are
unset, and none can stop a checkout. The daily and monthly ones keep their "last
ran" marker in the `job_state` table (`state/job-state.js`), which is what
turns twenty-four hourly ticks into one run.

**Back-in-stock alerts** (`runRestockAlerts` in `routes/restock.js`, every
tick). `POST /api/restock` -- the "Notify me when it's back" box -- stores the
address in `restock_signups` as well as emailing the owner. Each tick, every
pending signup whose product `products.json` now shows as buyable gets one
email opening with `site.automations.restockEmailIntro`, through
`sendMarketingEmail` (suppression list, `List-Unsubscribe`, the visible opt-out
line), keyed `restock-<product id>-<hash>` at Resend. `notified_at` is set
after a successful send -- and for a suppressed address, so it is not
reconsidered every hour -- while a Resend refusal leaves the row for the next
tick. At most 50 rows per tick. Off when `site.enableRestockAlerts` is `false`.

**Low-stock note** (`runLowStockCheck`, same file, once a day at 08:00
America/New_York, job `low-stock`). One email to the owner listing every
product whose `stock` is at or under `site.automations.lowStockThreshold`
(default 3), with how many shoppers are waiting on a restock alert for each.
Nothing low means no email. Goes to `ORDER_NOTIFY_EMAIL`, then
`RESTOCK_NOTIFY_EMAIL`, then `contact@yallternativeliving.com`. Off when
`site.enableLowStockAlerts` is `false`.

**Market reminders** (`routes/market-alerts.js`, once a day at
`site.automations.marketReminderHour` -- default 9, America/New_York -- job
`market-reminders`). The events page's "Email me the next market date" form
posts to `POST /api/market-alerts`: JSON from the fetch upgrade in `main.js`,
or a plain form post with JavaScript off, which is answered with a 303 back to
`events.html?market-alerts=saved` (or `=error`) -- never with the address in
the URL. The row in `market_alert_subscribers` holds the lower-cased address,
when it arrived, and `consent_text`: the exact sentence the form showed, so
every subscriber's record says what they were told (the route's `CONSENT_TEXT`
and `main.js`'s `MARKET_ALERT_CONSENT` are asserted equal by the test). The
job reads `assets/data/events.json` -- the file the page renders from -- and
for every market starting TOMORROW sends each subscriber one reminder opening
with `site.automations.marketReminderIntro`, keyed `market-<event id>-<hash>`.
It is a marketing send: same suppression list, same unsubscribe link, one
opt-out stops everything. `last_event_id` on the row is what keeps a resumed
run from repeating anyone; 50 sends per tick, and a run that hits the cap or
has a send refused rewrites the day marker to `<day>:partial` so the next
hourly tick picks up the rest. Needs `MAGIC_LINK_SECRET` and `RESEND_API_KEY`;
without them it logs one line and does not claim the day. Off when
`site.enableMarketReminders` is `false`.

**Monthly reaction export** (`routes/reaction-export.js`, once a month on the
1st, job `reaction-export`). One email to the owner with a CSV of every
`adverse_events` row filed in the previous New York calendar month: every
column, `outcomes` flattened to `a|b`, `created_at` as ISO plus the raw epoch
in a trailing `created_at_ms` column, UTF-8 with a BOM so Excel opens it
cleanly, and any cell starting with `=`, `+`, `-` or `@` prefixed with an
apostrophe so a reporter's description cannot run as a formula on the owner's
machine. The subject carries the row count and the serious count; the body says
what a serious one requires (Form FDA 3500A within 15 business days). **A month
with no reports still sends**, with a header-only file -- an unbroken run of
monthly files is the evidence that the check happened. Not a marketing send: it
goes through `sendEmail` with no unsubscribe link and no suppression check,
keyed `reaction-export-<YYYY-MM>` at Resend. A refused send re-opens the month
so the next tick retries, and the key means the file is never delivered twice.
Nothing is deleted -- exporting is not archiving. Goes to `SAFETY_REPORT_EMAIL`,
then `RESTOCK_NOTIFY_EMAIL`, then `contact@yallternativeliving.com`. Off when
`site.enableReactionExport` is `false`.

| Setting, var or table                                                                                          | Read by                                     | What it does                                                                                     |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `site.enableRestockAlerts`, `enableLowStockAlerts`, `enableMarketReminders`, `enableReactionExport`            | each job                                    | `false` switches that job off without claiming its day or month.                                 |
| `site.automations.lowStockThreshold` (default 3)                                                               | low-stock note                              | "At or under this" is low.                                                                       |
| `site.automations.restockEmailIntro`, `marketReminderIntro`                                                    | restock alerts, market reminders            | The opening line of the shopper-facing email.                                                    |
| `site.automations.marketReminderHour` (default 9)                                                              | market reminders                            | The New York hour the daily pass runs at. The low-stock note is fixed at 08:00.                  |
| `RESEND_API_KEY` (secret)                                                                                      | all four                                    | No key, no send: the job logs one line and skips without burning its marker.                     |
| `MAGIC_LINK_SECRET` (secret)                                                                                   | restock alerts, market reminders            | Signs the unsubscribe link. Without it no marketing email is sent at all.                        |
| `RESTOCK_NOTIFY_EMAIL`, `ORDER_NOTIFY_EMAIL`, `SAFETY_REPORT_EMAIL` (vars)                                     | low-stock note, reaction export             | Owner-side recipients; the fallback order is in each paragraph above.                            |
| `restock_signups`, `market_alert_subscribers`, `job_state` (D1, schema v4); `adverse_events` (v3)               | the jobs                                    | The tables. `adverse_events` is only ever read by the export and is swept by nothing.            |

Tests: `scripts/worker-restock.test.js`, `scripts/worker-market-alerts.test.js`
and `scripts/worker-reaction-export.test.js` -- Node only, D1 emulated on
`node:sqlite`, Resend and the site JSON stubbed.

### 3. Set the secrets

In the Cloudflare dashboard (the Worker -> Settings -> Variables and Secrets), or
with the CLI. Never as `[vars]`, never in a committed file:

```bash
npx wrangler secret put STRIPE_SECRET_KEY      # Checkout Sessions, Coupons, Customers write; Tax Settings read
npx wrangler secret put STRIPE_WEBHOOK_SECRET  # from step 4 -- also keys the gift-card code derivation
npx wrangler secret put RESEND_API_KEY         # from the verified Resend account
npx wrangler secret put MAGIC_LINK_SECRET      # 32+ random chars; signs unsubscribe and points links
```

Optional vars: `RESTOCK_NOTIFY_EMAIL` (where restock alerts go; defaults to
`contact@yallternativeliving.com`), `SAFETY_REPORT_EMAIL` (where MoCRA reaction
reports go; falls back to `RESTOCK_NOTIFY_EMAIL`, then the same default),
`GIFT_CARD_FROM_EMAIL` and `RETENTION_FROM_EMAIL` (different verified Resend
senders), plus the retention vars in step 2b (`STRIPE_*_COUPON_ID`,
`LOYALTY_REDEEM_THRESHOLD`, `LOYALTY_REWARD_CENTS`).

`MAGIC_LINK_SECRET` is also the salt for the `ip_hash` column on
`adverse_events`. Rotating it means older and newer rows hash the same visitor
differently -- harmless (that column only ever groups abuse), but worth knowing
before anyone reads it as an identifier.

`STRIPE_WEBHOOK_SECRET` is load-bearing twice over: it verifies Stripe's
signature AND it is the HMAC key the purchased gift-card codes are derived from.
Rotating it makes future codes derive differently -- which is fine, because
already-issued codes live in the ledger and are never re-derived -- but a
webhook redelivery that straddles the rotation would issue a second card for the
same purchase. Rotate when no delivery is in flight.

### 4. Register the Stripe webhook

Stripe Dashboard -> Developers -> Webhooks -> Add endpoint:

```
https://yallternativeliving.com/api/stripe-webhook
```

Subscribe to exactly these three:

- `checkout.session.completed` -- issues the cards an order bought and commits
  the hold on a card an order spent,
- `checkout.session.expired` -- releases the hold and deletes the ephemeral
  coupon an abandoned checkout leaves behind,
- `charge.refunded` -- puts a refunded order's gift-card share back on the card.
  Do NOT also select `refund.created`: it fires for the same money.

There is no fourth. The "your order is on its way" email is NOT webhook-driven:
Stripe has no `payment_intent.updated` event and fires nothing when
PaymentIntent metadata is edited, so it is sent by the Worker's hourly cron
instead (see **Marking an order shipped** below). `routes/stripe-webhook.js`
keeps a dormant branch for that event name in case Stripe ever adds it; there
is nothing to select for it in the Dashboard.

### Marking an order shipped

There is no fulfilment dashboard: an order is marked shipped by adding metadata
to its **PaymentIntent** in Stripe (Payments -> the payment -> Metadata ->
"Edit metadata"). Three keys, all optional except the first:

| Key                  | Value                                        |
| -------------------- | -------------------------------------------- |
| `fulfillment_status` | `shipped` (or `delivered` / `fulfilled`)     |
| `tracking_url`       | the carrier's tracking link, `https://…`     |
| `shipped_at`         | free text, shown on the order-status page    |

Saving that does three things: order-status.html starts reading "Shipped" with
a Track button (`state/stripe-orders.js`), the customer gets the ship notice
(`routes/ship-notice.js`), and the post-purchase sequence is re-anchored on the
real dispatch date instead of the assumed one (`routes/retention-emails.js`).

Set the status and the tracking link in the SAME save if you can. Only the
first save sends -- the notice is recorded per order in `order_emails` so a
later correction to the link cannot mail the customer twice -- so a tracking URL
added afterwards will show on the status page but will not have been in the
email.

**It must be on the PaymentIntent, not the Checkout Session or the Charge.**
That is the object `state/stripe-orders.js` reads. Stripe fires **no webhook
event** for a metadata edit on a PaymentIntent (there is no
`payment_intent.updated`; checked against Stripe's event list 2026-09-04), so
the notice is sent by the Worker's hourly cron: `runShipNoticeSweep` in
`routes/ship-notice.js` lists the last 45 days of PaymentIntents and emails
every order marked shipped that has not been told yet. Expect the customer's
email within the hour of the save, not within seconds.

Copy the signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.

That URL goes through the Netlify proxy (`/api/*` -> the Worker, generated by
`scripts/build-security-headers.js`). **The proxy must pass the raw body through
unchanged**, because the signature is computed over the exact bytes; Netlify's
proxying does not rewrite bodies, but this is the thing to suspect first if
Stripe reports signature failures. The fallback is to register the workers.dev
URL with Stripe directly:

```
https://yallternative-checkout.y-allternative-living.workers.dev/stripe-webhook
```

Note the missing `/api` in that form -- the proxy's `:splat` drops the prefix, so
the Worker's router accepts both spellings.

Test mode first: run a real test-mode Checkout that buys a gift card, confirm the
recipient email arrives with a `YALL-XXXX-XXXX-XXXX` code, check that code on the
site's balance page, then spend it in a second test-mode Checkout and confirm the
balance goes down.

### 5. Clean up Netlify

In Netlify's **Project configuration -> Environment variables**, delete the
variables the retired functions used: `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `RESTOCK_NOTIFY_EMAIL`,
`RESTOCK_FROM_EMAIL`, `GIFT_CARD_FROM_EMAIL`, `FROM_EMAIL`. Nothing in the
Netlify build reads them any more, and a live Stripe key sitting in a second
provider's dashboard is a second place it can leak from.

Delete the old Stripe webhook endpoint
(`…/.netlify/functions/fulfill-gift-card`) **after** the Worker has processed
real events, not before. Both can run at once for observation only: `claimEvent`
makes double processing impossible _within_ one deployment, not across two.

### 6. Optional: the Rate Limiting binding

`workers/state/rate-limit.js` uses `env.RATE_LIMITER` when it exists and falls
back to an exact Durable Object counter when it does not, so the shipped
configuration (binding commented out in `wrangler.toml`) works as-is. Enabling
the binding trades exactness for cost: it is free and storage-free, but enforced
per Cloudflare location rather than globally. Check whether it is offered on this
account's free plan before relying on it -- the instructions are in
`wrangler.toml` next to the commented block.

---

## What the gift-card ledger does and does not guarantee

Gift cards are **stored-value balances in a `GiftCardLedger` Durable Object**,
one object per code. Stripe holds no balance at all: a redemption mints a
single-use `amount_off` coupon for the amount the ledger agreed to hold, and
that coupon is the only thing Stripe ever sees.

This replaced a design where the card _was_ a Stripe Promotion Code. Two things
that used to be documented limits are now closed:

- **Double-spend (audit C-2) is closed.** Every request for a code lands on the
  same Durable Object, which processes one at a time, so `reserve` either takes
  the whole amount or refuses. Two tabs with the same $50 card and a $40 basket
  each: the first holds $40, the second is refused with a 409 ("That gift card
  balance changed; please re-apply it."), its coupon is deleted and its session
  is expired so it cannot be paid. A `CHECK (balance_cents >= 0)` constraint
  means even a logic bug cannot persist a negative balance.
- **The balance endpoint is throttled.** 10 lookups a minute per IP, plus the
  same generic 404 for "no such code", "spent" and "no balance", plus
  `no-store`, plus a code space of 32^12 (~1.15e18) instead of 36^8 with modulo
  bias.

What is still true and worth knowing:

- **A hold is released after 24 hours, not sooner.** The Durable Object's alarm
  sweeps reservations older than a Stripe session's maximum life. A shopper who
  abandons a checkout normally gets the money back immediately (Stripe sends
  `checkout.session.expired`); the alarm is the backstop for an event that never
  arrives.
- **The IP a rate limit counts is the one Netlify reports.** Requests arrive
  through the proxy, so `CF-Connecting-IP` is Netlify's edge address; the first
  `X-Forwarded-For` entry is used instead, and that is client-influenced.
  Nothing is authorised by it -- it only picks a counter bucket -- but a
  determined caller can rotate buckets. Serving the Worker from a Cloudflare
  route on the apex domain would fix it.
- **Tax treatment is unchanged.** A redemption still reaches Stripe as a
  discount, so Stripe rates the reduced amount, while tax law generally treats a
  gift card as a payment method. The balance is real now; the tax shape is not
  something this layer can fix.
- **Codes are immutable.** A card's Durable Object is addressed by its code, so
  reissuing a card under a new code does not carry its balance across.

---

## CSP reminder

If you deploy either Worker on your own domain path (e.g. `/api/*`), no CSP
change is needed (same origin). If you host Stripe Checkout redirects, Stripe
handles its own page. If you embed the Turnstile widget, add
`https://challenges.cloudflare.com` to `script-src` and `frame-src` in
`scripts/build-security-headers.js`, then run `npm run build-security-headers`.
