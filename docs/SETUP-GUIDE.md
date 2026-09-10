# Y'allternative Living Website — Setup Guide

The click-by-click launch checklist. For the technical _why_ behind any
step, see the matching section in [DEVELOPMENT.md](DEVELOPMENT.md).

Create every account below yourself, not me on your behalf — your
email, your two-factor login, your recovery options, so nothing about
your business is locked behind my login. Step 3B is the only one that
also needs technical help: you make the account, then invite me in as
a helper, just like Step 1 invites you into the GitHub organization.

---

## Step 1: Accept Your GitHub Invitation

1. Find the GitHub invitation email to join the `yallternative-living`
   organization and accept it.

---

## Step 2: Hosting & Domain (Netlify & Porkbun)

Netlify hosts the site for free.

**A. Deploy on Netlify**

1. Sign up at [Netlify.com](https://www.netlify.com) → **Add New Site
   → Import an existing project → GitHub**.
2. Authorize the **`yallternative-living` organization** (not your
   personal profile) → **Only select repositories** → check
   `yallternative-living/yallternative-living` → **Install & Authorize**.
3. Select that repository and click **Deploy Site** — leave the build
   settings alone, `netlify.toml` already has the right command.

**B. Point Porkbun's nameservers at Netlify**

1. In Netlify: **Project configuration → Domain management → Add a
   domain** (Netlify has renamed "Site settings" to "Project
   configuration" — look for whichever wording your dashboard shows) →
   enter `yallternativeliving.com` → copy the 4 nameservers shown (e.g.
   `dns1.p01.nsone.net`).
2. In Porkbun: **Domain Management → yallternativeliving.com → Details
   → edit Nameservers** → paste the 4 Netlify values → **Submit**. It
   can take a little while for the new address to work everywhere —
   usually under an hour, sometimes up to 48.

**C. Logging into `/admin` — skip Netlify entirely**

Netlify's old "Git Gateway / OAuth" login is **deprecated** (that's the
"This feature is deprecated" warning you may have seen — not your fault,
it just doesn't work anymore). You don't need it. Your `/admin` login is
handled two other ways instead — see **Step 9** below. The fastest one
(paste a GitHub token) needs nothing set up here at all, so you can move
straight on to Step 3.

---

## Step 3: Payments & Cart (Stripe)

On-site cart + direct Stripe Checkout — $0/month, just Stripe's normal
per-transaction fee.

**A. Stripe account**

1. Sign up at [Stripe.com](https://stripe.com) and activate with your
   business details, EIN/tax ID, and bank routing number.
2. Stay in **Test Mode** for now (top-right toggle).
3. **Developers → API keys** → copy the **Secret key** (`sk_test_...`).
   Ignore "Publishable key" and "Create restricted key" — I'll handle
   the restricted one later.
4. **Developers → Webhooks → Add endpoint** → paste
   `https://yallternativeliving.com/api/stripe-webhook`
   → choose **five** events, not one:
   - `checkout.session.completed` (delivers the gift card once the payment
     has actually gone through)
   - `checkout.session.async_payment_succeeded` and
     `checkout.session.async_payment_failed` (only matter if you ever turn on
     a bank-transfer style payment method that settles days later; harmless
     to tick now, and the site is ready for them)
   - `checkout.session.expired` (cleans up the temporary coupon behind an
     abandoned gift-card checkout — without it they pile up in your Stripe
     account forever)
   - `charge.refunded` (puts a fully refunded order's gift-card balance back;
     a partial refund of the card payment leaves the gift card alone)

   (You will not find a `payment_intent.updated` event: Stripe has none. The
   "your order is on its way" email is sent by the Worker's hourly check when
   you mark an order shipped — see "Marking an order shipped" in
   `workers/README.md`.)

   Do **not** also tick `refund.created`: it fires for the same money and the
   code deliberately ignores it. Then copy the **Signing secret**
   (`whsec_...`).

   > Keep that signing secret. **Rotating it changes every gift-card code the
   > site would generate** — codes are derived from it — so a rotation makes
   > cards already in customers' inboxes underivable. Rotate only with a plan
   > for the cards already out there.

**B. Cloudflare account — you create it, I set it up**

Cloudflare runs the code that actually charges the card. It holds your
Stripe key, so it needs to be your account, not mine.

1. Sign up free at [Cloudflare](https://dash.cloudflare.com/sign-up)
   with your own email.
2. **Manage Account → Members → Invite** → my email. That lets me work
   inside your account without it ever becoming mine — remove my
   access any time.
3. **Do not send anyone your Secret key or Signing secret** — not by email,
   not by text, not in a chat. A Stripe secret key can charge cards and move
   money; once it has been in a message thread it is compromised, and the only
   safe response is to roll it. Paste it yourself, into the dashboard, where
   it is going to live:

   - **Secret key** and **Signing secret** → Cloudflare: your Worker →
     **Settings → Variables and Secrets** → add both as **Secrets**:
     - `STRIPE_SECRET_KEY` (your Stripe Secret key, e.g. `sk_test_...`)
     - `STRIPE_WEBHOOK_SECRET` (your Stripe Signing secret, e.g. `whsec_...`)
       (Note: Netlify hosts only the static website and requires no Stripe secrets.)

   Because you invited me into your Cloudflare account in step 2, I can see
   that the variables are set and finish the wiring without ever seeing their
   values. Tell me when they are in, then move to Part C. (If a key ever does
   end up in a message: **Developers → API keys → Roll key** in Stripe,
   immediately.)

**C. Test, then go live**

1. Run a test purchase — one regular product and one gift card — with
   [Stripe's test cards](https://docs.stripe.com/testing). Confirm it
   reaches the thank-you page and the gift-card email arrives.
2. Switch Stripe to **Live Mode** (same toggle), copy the **live** Secret key
   and the **live** Webhook Signing secret, and paste them yourself into
   Cloudflare (your Worker → **Settings → Variables and Secrets**) exactly as in
   Part B step 3 — replacing the `sk_test_...` and `whsec_...` values. Netlify is
   NOT involved. Same rule: the live key never travels through a message to anyone,
   including me.

**D. Sales tax — you almost certainly need this on**

SC businesses must collect sales tax from their first sale (no
small-seller exemption). Confirm with your accountant, but expect a yes.

1. Get a **SC retail license** if you don't have one — [MyDORWAY](https://dor.sc.gov/register).
2. In Stripe: **Tax → Settings** → your address, then **Tax → Registrations** → South Carolina.
3. An hour later, check for a tax line on a test purchase. Missing the
   next day? Tell me.

Also add a **ZIP code** to any pickup market (`/admin` → Markets), so
those orders tax correctly.

**E. Promo codes — made in Stripe, shown in the cart**

A promo code is two things in Stripe: a **coupon** (what it takes off) and a
**promotion code** (the word shoppers type). The cart's "Have a code?" box
checks the code with Stripe as soon as it is typed and shows the discount and
the new total before checkout, so nobody discovers on the payment page that a
code did nothing. Click by click:

1. Stripe Dashboard → **Products** (left sidebar) → **Coupons** → **+ New**
   (or **Create coupon**).
2. **Name**: what you will see on receipts and reports, e.g. `Spring 10% off`.
3. **Type**: pick **Percentage discount** and enter the percent (e.g. `10`),
   *or* **Fixed amount discount** and enter the dollars, with the currency
   set to **USD**. Both kinds work in the cart; anything not in USD is
   refused as "doesn't apply".
4. **Duration**: **Once** is right for a shop (it only matters for
   subscriptions). Leave **Apply to specific products** *unticked* — the
   shop prices its own goods at checkout, so a coupon pinned to Stripe
   products never matches anything and the cart says the code doesn't apply.
5. Optional: **Redemption limits** — a **redeem-by date** and a **maximum
   number of times** the coupon can be used across everyone. Then
   **Create coupon**.
6. On the new coupon's page, find **Promotion codes** → **+ New** (or
   **Create promotion code**).
7. **Code**: the word shoppers will type — letters, numbers and dashes, up to
   40 characters, e.g. `YALL10`, `PRIDE-2026`. Stripe ignores upper/lower
   case; the cart upper-cases what is typed. Do **not** start it with
   `YALL-` followed by groups of four — that is the gift-card format and the
   cart will send the shopper to the gift card box instead.
8. Optional restrictions on that page — every one of these is honoured by the
   cart:
   - **Minimum order value** (e.g. `$50`): under it the cart says
     "This code needs a subtotal of at least $50" and adds the discount the
     moment the cart reaches it. The minimum is against the goods, before
     shipping.
   - **First-time customers only**: the cart shows "first order only" next
     to the code; Stripe enforces it at checkout.
   - **Expiration date** and **limit to a number of uses** for the code
     itself.
9. **Create**. The code works immediately. Test it: add something to the
   cart on the live site, click **Have a code?**, type it, and watch the
   "Promo code (…)" line and the total change.

Two rules the cart explains to shoppers so you do not have to:

- **One discount per order.** Stripe allows a single discount on a checkout,
  and a gift card uses that slot. A shopper with a gift card applied who
  enters a promo code sees "Promo codes and gift cards can't be combined" —
  the code is kept, greyed out, and comes back if they remove the card. The
  wording is yours to change in `/admin` → Site Settings.
- **Codes discount goods, not shipping.** Stripe never applies a coupon to
  the shipping rate. For free shipping use the free-shipping threshold.
- **Codes never discount a gift card.** A shopper buying a gift card sees
  "Codes can't be used to buy gift cards", and Stripe's own code field is off
  for that checkout too. Otherwise a 10% code would sell $25 of store credit
  for $22.50, and the card would still redeem at $25.

To pause the whole thing, `/admin` → **Site Settings** → **⚙️ Site Settings**
→ untick **Shop · Accept promo codes in the cart**. The box disappears from
the cart; Stripe's own code field on the payment page keeps working. To
retire one code, deactivate the promotion code in Stripe (**Products →
Coupons → the coupon → Promotion codes → ⋯ → Archive**) — the cart then
answers "That code has expired or has already been used" and takes it off
any cart that still has it applied.

---

## Step 4: Newsletter (Kit)

1. Sign up at [Kit.com](https://kit.com) → **Grow → Landing Pages &
   Forms → Create new → Form → Inline** → pick any template → **Publish
   → HTML**.
2. Copy the URL inside `action="..."` (`https://app.kit.com/f/g/...`).

---

## Step 5: Forms (Formspree) — three forms, not two

1. Sign up at [Formspree.io](https://formspree.io) and **verify your
   email** (unverified accounts silently drop incoming messages).
2. Create three forms: **Contact**, **Reviews**, and **Restock Alerts**
   (the "email me when it's back" signup on sold-out products).
3. Copy each form's ID from its Integration tab.

---

## Step 6: Gift-Card Emails (Resend) — required

This is what actually sends the gift-card email once someone buys one.
**Two parts, and both are required** — the email is sent from
`gifts@yallternativeliving.com`, and Resend won't let anyone send from
your domain until you prove you own it (step 1). Skipping that doesn't
error loudly: the purchase still completes, but the recipient's email
silently never arrives.

1. **Verify your domain in Resend** (do this first): [Resend.com](https://resend.com)
   sign up → **Domains → Add Domain** → enter `yallternativeliving.com` →
   Resend shows you a few DNS records (a couple of TXT records and an
   MX record) → add each one, exactly as shown, wherever your domain's
   DNS is managed. **Since Step 2B pointed this domain's nameservers at
   Netlify, that's now Netlify** — in Netlify: **Domain management →
   DNS records → Add a record** (not Porkbun anymore). Back in Resend,
   click **Verify** — usually confirms within 15 minutes, occasionally
   up to 24 hours.
2. **API Keys → Create API Key** → copy it (`re_...`).
3. In Cloudflare: your Worker → **Settings → Variables and Secrets** → add
   `RESEND_API_KEY` as a **Secret** (pasting it yourself — see Step 3).
   The gift-card email turns itself on once all three secrets (`STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET`, and `RESEND_API_KEY`) are set in Cloudflare AND the
   domain above shows Verified in Resend. Netlify does NOT host functions and
   holds none of these secrets.

   Optional extras in Cloudflare (Workers Settings → Variables and Secrets),
   only if you want to change a default:
   `FROM_EMAIL` (the address gift-card emails come from),
   `RESTOCK_NOTIFY_EMAIL` (where "tell me when this is back" requests land)
   and `GIFT_CARD_FROM_EMAIL` (which defaults to
   `orders@yallternativeliving.com`). Whatever you set has to be a sender
   address Resend has verified for your domain. The full list of every
   variable, and which Worker route reads it, is in
   `docs/DEVELOPMENT.md` section 8a.
4. **Shop alerts use this same key** -- nothing extra to set up. Once
   `RESEND_API_KEY` is in place, the checkout Worker emails you when
   something behind the scenes fails (a payment webhook that keeps erroring,
   sales tax that could not be switched on, an hourly job that died, a
   customer email given up on). They go to the address in your dashboard
   under **Site Settings → Emails to me → Where shop alerts go**, or to the
   shop's order mailbox (`ORDER_NOTIFY_EMAIL`, set in Cloudflare) when that
   is blank. One email per problem every six hours at most. If the Resend
   key is missing, the alert is written to the Worker's log instead
   (Cloudflare → the Worker → **Logs**, search `owner-alert`) -- which is
   the one place nobody looks, so set the key.

5. **The "Your Orders" page needs nothing extra.** `/orders.html` lets a
   returning customer email themselves a one-time link to their order
   history (no account, no password). It runs on this same `RESEND_API_KEY`
   and on `MAGIC_LINK_SECRET`, the signing secret the points and unsubscribe
   links already use (`workers/README.md` step 3). If both are set in
   Cloudflare, the page already works; if either is missing, the page says
   "temporarily unavailable" rather than pretending. The wording and the
   on/off switch are in your dashboard (`docs/EDITING-GUIDE.md`,
   Walkthrough 5c).

---

## Step 7: Live Chat (Tawk.to) — optional

1. Sign up at [Tawk.to](https://www.tawk.to) → **Administration → Chat
   Widget → Direct Chat Link** → copy the **Property ID** and **Widget
   ID**. (Skipping it? Tell me and I'll strip the placeholder out for a
   small speed boost.)

---

## Step 8: Analytics (Umami) — optional, privacy-friendly

1. Sign up at [Umami.is](https://umami.is), add
   `yallternativeliving.com`, copy the **Website ID**.

---

## Step 9: Your Dashboard (Sveltia CMS)

Once the site is live, everything below is yours to edit at
`yallternativeliving.com/admin/` — no code, no file edits.

**Logging in — two ways (Netlify is NOT involved):**

- **Fastest, works right now — "Sign in with Token":** on GitHub, go to
  **Settings → Developer settings → Personal access tokens →
  Fine-grained tokens → Generate new token**. Under **Repository
  access** choose **Only select repositories** → the
  `yallternative-living/yallternative-living` repo. Under **Repository
  permissions** set **Contents → Read and write** (leave everything else
  alone). Pick an expiration, click **Generate token**, and copy it.
  Then go to `/admin`, click **Sign in with Token**, and paste it. Keep
  that token private, like a password. (If it ever expires, just make a
  new one the same way.)
- **Permanent one-click "Sign in with GitHub" button:** a small one-time
  setup Steven does (a GitHub OAuth App + a Cloudflare login service —
  see **DEVELOPMENT.md Section 20, Option B**). After that, `/admin` just
  shows a **Sign in with GitHub** button and there's no token to manage.

Once you're in:

1. Visit `/admin` → sign in (either method above).
2. **Switches & branding** (first thing in the Site Settings section):
   - **Integration codes** — Kit link, all 3 Formspree IDs, live chat
     IDs, analytics ID.
   - **Feature switches (on/off)** — Journal, Social Feed, Restock Alerts,
     Ingredients Info, Custom Box Builder, Scent Filter, Local Pickup,
     Countdown Ticker, Order Lookup, Rewards Points, Apothecary Quiz.
   - **Rewards Points** — rename "Alt-Points," set points per $1, pick
     an icon emoji.
   - **Markets, Fairs & Pride Dates** — pickup markets need a ZIP for
     tax (Step 3D).
   - **Products & Markets** — prices, descriptions, pop-up dates, FAQ.

---

## Step 10: Your Square Register (recommended — you already pay for it)

Your Square register and your website sell off the **same shelf**. Once this
is connected, every sale you ring up at a market — cash, card, tap, even a
freebie you ring as a 100% discount — comes off the site's Stock count within
seconds, and the register shows the same "3 left" the site does. No more
recounting on Sunday night.

**A. Give every item a SKU in Square (this is the whole trick)**

1. Square Dashboard → **Items & Orders → Items** → open an item. Each size or
   variation has a **SKU** field.
2. Type the product's **ID from the website** — the last part of the product
   page's address: `yallternativeliving.com/products/lavender-soak.html` →
   `lavender-soak`.
3. If an item has sizes, give each size the ID plus the size:
   `lavender-soak/10-oz`, `lavender-soak/24-oz`. They all count the same shelf.
4. Gift sets: use the set's ID (e.g. `starter-self-care-set`). Ringing one up
   counts each product inside it.
5. Turn **Track inventory** on for the item, so the count the site sends has
   somewhere to show up.

Already have SKUs you don't want to retype? Fine — in `/admin`, open the
product and list them under **Square SKUs**.

**B. Connect it — you create, I set up** (same idea as Cloudflare)

1. Sign in at [developer.squareup.com](https://developer.squareup.com) with
   the Square account your register uses → **+ Create application** → name it
   "Y'allternative site".
2. Invite me to it (or share your screen) and I'll copy two things into the
   Cloudflare Worker: the **Production Access Token** and the webhook
   **Signature Key**. **Don't email them.**
3. Ring up a $0 test item at the register and watch the site's count drop.

**C. Two rules once it's live**

- **Ring everything through Square.** A cash sale that only lives in your
  head is a sale the site never hears about.
- **Fix counts in `/admin`, not in Square.** The website is the boss of the
  number; anything typed into Square's stock field is overwritten within the
  hour. If an item you sell at the table isn't matched to the site, you get an
  email naming it — fix its SKU, then adjust the Stock count for the ones
  already sold.

**Site settings → Shop → Sync stock with Square** pauses the whole thing if
you ever need to.

## Complete Handoff Checklist

**Required**

1. Stripe Secret Key: `_____________________`
2. Stripe Webhook Signing Secret: `_____________________`
3. Has Steven confirmed the payment code is connected (Step 3B)? ☐ Yes ☐ Not yet
4. Kit Newsletter Form Link: `_____________________`
5. Formspree Contact Form ID: `_____________________`
6. Formspree Review Form ID: `_____________________`
7. Formspree Restock Alerts Form ID: `_____________________`
8. Resend API Key: `_____________________`
9. Sales tax registered and confirmed on a test purchase (Step 3D)? ☐ Yes ☐ Not yet ☐ Not needed

**Optional**

10. Tawk.to Property ID: `_____________________`
11. Tawk.to Widget ID: `_____________________`
12. Umami Website ID: `_____________________`
13. Square application created and Steven invited (Step 10B)? ☐ Yes ☐ Not yet
14. Square Location ID: `_____________________`
15. Every Square item has a SKU matching its product ID (Step 10A)? ☐ Yes ☐ Not yet

_No Stripe Publishable Key is needed anywhere on this site._
