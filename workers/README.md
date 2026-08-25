# Cloudflare Workers (checkout + CMS login + forms)

`checkout.js` is the live checkout backend: the on-site cart (`assets/js/cart.js`)
POSTs to it and gets back a Stripe Checkout URL. Snipcart is fully removed (see
`docs/STRIPE-MIGRATION.md`) -- this Worker is what replaced it, and it needs to
actually be deployed (with real Stripe keys) before checkout works in production.

`auth/sveltia-auth.js` is the **CMS sign-in service** -- the permanent "Sign in
with GitHub" button for the Sveltia CMS product editor at `/admin`. It replaces
Netlify's deprecated "Git Gateway / OAuth" login, so `/admin` depends on nothing
from Netlify. It's its own separate Worker in `workers/auth/` (see the section
below). Optional to deploy: Savanna can also log in immediately with a token
("Sign in with Token") and set this up later.

`submit-form.js` is still **optional** -- the contact/review forms currently post
to Formspree directly, and this Worker is only worth deploying if you want that
mail coming from your own domain or you outgrow Formspree's free tier.

Both started as corrected versions of the drafts from `sota_research_2026.md`,
which had real security bugs (wildcard CORS, unescaped email HTML, no quantity
caps, no server-side price validation). See the header comment in each file.

There's also `netlify/functions/fulfill-gift-card.js` -- not a Cloudflare
Worker (it's a Netlify Function, deployed automatically alongside the site
build since it lives under `netlify/functions/`), but part of the same
checkout flow: it's the `checkout.session.completed` webhook that actually
emails a redeemable code once someone buys a gift card. See the header
comment in that file for its own required env vars and deploy step (register
the endpoint in the Stripe Dashboard).

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

| Option | Server needed? | Best for |
| --- | --- | --- |
| **Stripe Payment Links** | None (static URLs) | Simplest. One link per product/price, created in the Stripe dashboard. No cart, no Worker. Good if most orders are single items. |
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
which method is best for *Steven doing it*, not about avoiding a
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
5. Point a route at it (e.g. `yallternativeliving.com/api/checkout`).
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
   type **Secret** (same restricted-key guidance as Option B step 3).
4. **Settings -> Domains & Routes -> Add -> Route** ->
   `yallternativeliving.com/api/checkout`.
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

## Sign-in Worker (CMS login) — `auth/sveltia-auth.js`

This is the **permanent "Sign in with GitHub" button** for the Sveltia CMS
product editor at `/admin` (DEVELOPMENT.md section 20, Option B). It's the
modern replacement for Netlify's deprecated "Git Gateway / OAuth" login —
`/admin` no longer depends on Netlify for anything.

It's a **separate Worker** from checkout, in its own folder (`workers/auth/`)
with its own committed `wrangler.toml`, kept apart on purpose: the checkout
Worker holds the Stripe secret and handles real payments, so the CMS login
stays isolated from it. Nothing secret is committed here either — the GitHub
client secret only ever lives as a Cloudflare Secret.

> **Alternative that needs none of this:** Savanna can log in *today* with
> **"Sign in with Token"** on the `/admin` screen (a GitHub fine-grained token,
> zero infrastructure — SETUP-GUIDE.md Step 9 / DEVELOPMENT.md section 20
> Option A). This Worker is the nicer, permanent login you graduate to.

**Setup (once):**

1. **GitHub OAuth App** — GitHub → **Settings → Developer settings → OAuth
   Apps → New OAuth App** (the short *OAuth App* form, **not** "GitHub App").
   Homepage URL `https://yallternativeliving.com`. Copy the **Client ID**,
   generate + copy a **Client Secret**. Set the **Authorization callback URL**
   after step 2 to `<this-Worker-URL>/callback`.
2. **Deploy `workers/auth/`** — same two paths as checkout above:
   - **Workers Builds (dashboard):** Workers & Pages → Create → Import a
     repository → this repo, project root **`workers/auth`** (checkout's root
     is `workers`; each Worker is its own Workers Builds project). Redeploys on
     every push, no `wrangler deploy` by hand.
   - **Wrangler CLI:** `cd workers/auth && wrangler deploy`.

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

## Deploying `netlify/functions/fulfill-gift-card.js`

This one deploys with the rest of the site (Netlify auto-detects anything
under `netlify/functions/`, no extra config needed) -- but it does nothing
useful until it's registered as a Stripe webhook endpoint:

1. In Netlify's site settings -> Environment variables, set:
   - `STRIPE_SECRET_KEY` (same key as the Worker, needs Coupons +
     Promotion Codes write access)
   - `STRIPE_WEBHOOK_SECRET` (get this in the next step)
   - `RESEND_API_KEY` (already needed if you use Resend elsewhere)
2. Deploy once so the function has a live URL:
   `https://yallternativeliving.com/.netlify/functions/fulfill-gift-card`
3. In the Stripe Dashboard: Developers -> Webhooks -> Add endpoint, paste that
   URL, and select the `checkout.session.completed` event. Stripe shows you a
   signing secret (`whsec_...`) -- that's `STRIPE_WEBHOOK_SECRET` from step 1.
4. Test mode first: run a real test-mode Checkout that includes a gift card,
   confirm the recipient email arrives with a code, and confirm that code
   actually applies at a second test-mode Checkout (the Worker sets
   `allow_promotion_codes: true` so it should show up as a redeemable code
   field on Stripe's hosted page).

See the header comment in `fulfill-gift-card.js` for how the webhook
signature is verified and why this couldn't be tested against a real Stripe
delivery in the environment this was built in.

---

## CSP reminder

If you deploy either Worker on your own domain path (e.g. `/api/*`), no CSP
change is needed (same origin). If you host Stripe Checkout redirects, Stripe
handles its own page. If you embed the Turnstile widget, add
`https://challenges.cloudflare.com` to `script-src` and `frame-src` in
`scripts/build-security-headers.js`, then run `npm run build-security-headers`.
