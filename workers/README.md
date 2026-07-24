# Cloudflare Workers (checkout + forms)

`checkout.js` is the live checkout backend: the on-site cart (`assets/js/cart.js`)
POSTs to it and gets back a Stripe Checkout URL. Snipcart is fully removed (see
`docs/STRIPE-MIGRATION.md`) -- this Worker is what replaced it, and it needs to
actually be deployed (with real Stripe keys) before checkout works in production.

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

1. `npm i -g wrangler` and `wrangler login`.
2. `cp wrangler.toml.example wrangler.toml`, confirm `SITE_ORIGIN`.
3. `wrangler secret put STRIPE_SECRET_KEY` (use a **restricted** key limited to
   Checkout Sessions + Coupons + Promotion Codes write, since
   `fulfill-gift-card.js` also needs to create those).
4. `wrangler deploy`.
5. Point a route at it (e.g. `yallternativeliving.com/api/checkout`).
6. That's the whole client-side contract: `assets/js/cart.js` already POSTs
   `{ items: [{ id, qty, variant }] }` here and redirects the browser to
   whatever Checkout URL comes back -- no further client changes needed.

Security notes already handled in the code: CORS is locked to your origins,
prices are re-derived from `products.json` (client prices are ignored),
quantities are integer-clamped 1–99, and both `products` and `bundles` are
searched.

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
