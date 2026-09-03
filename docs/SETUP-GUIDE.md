# Y'allternative Living Website — Setup Guide

The click-by-click launch checklist. For the technical *why* behind any
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
   `https://yallternativeliving.com/.netlify/functions/fulfill-gift-card`
   → choose **three** events, not one:
   - `checkout.session.completed` (delivers the gift card)
   - `checkout.session.expired` (cleans up the temporary coupon behind an
     abandoned gift-card checkout — without it they pile up in your Stripe
     account forever)
   - `charge.refunded` (puts a refunded order's gift-card balance back)

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

   - **Secret key** → Cloudflare: your Worker → **Settings → Variables and
     Secrets** → add `STRIPE_SECRET_KEY` as a **Secret**.
   - **Secret key** and **Signing secret** → Netlify: **Project configuration
     → Environment variables** → add `STRIPE_SECRET_KEY` and
     `STRIPE_WEBHOOK_SECRET`.

   Because you invited me into your Cloudflare account in step 2, I can see
   that the variables are set and finish the wiring without ever seeing their
   values. Tell me when they are in, then move to Part C. (If a key ever does
   end up in a message: **Developers → API keys → Roll key** in Stripe,
   immediately.)

**C. Test, then go live**

1. Run a test purchase — one regular product and one gift card — with
   [Stripe's test cards](https://docs.stripe.com/testing). Confirm it
   reaches the thank-you page and the gift-card email arrives.
2. Switch Stripe to **Live Mode** (same toggle), copy the **live** Secret key,
   and paste it yourself into Cloudflare and Netlify exactly as in Part B
   step 3 — replacing the `sk_test_...` value. Same rule: the live key never
   travels through a message to anyone, including me.

**D. Sales tax — you almost certainly need this on**

SC businesses must collect sales tax from their first sale (no
small-seller exemption). Confirm with your accountant, but expect a yes.

1. Get a **SC retail license** if you don't have one — [MyDORWAY](https://dor.sc.gov/register).
2. In Stripe: **Tax → Settings** → your address, then **Tax → Registrations** → South Carolina.
3. An hour later, check for a tax line on a test purchase. Missing the
   next day? Tell me.

Also add a **ZIP code** to any pickup market (`/admin` → Markets), so
those orders tax correctly.

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
3. In Netlify: **Project configuration → Environment variables** → add
   three values, pasting them yourself (they are secrets — see Step 3):
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `RESEND_API_KEY`. The
   gift-card email turns itself on once all three are filled in AND the domain
   above shows Verified.

   Optional extras in the same place, only if you want to change a default:
   `FROM_EMAIL` (the address gift-card emails come from),
   `RESTOCK_NOTIFY_EMAIL` (where "tell me when this is back" requests land)
   and `GIFT_CARD_FROM_EMAIL` (which defaults to
   `orders@yallternativeliving.com`). Whatever you set has to be a sender
   address Resend has verified for your domain. The full list of every
   variable, and which function reads it, is in
   `docs/DEVELOPMENT.md` section 8a.

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
2. **⚙️ Site Settings & Switches** (first thing in the Site Settings section):
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

*No Stripe Publishable Key is needed anywhere on this site.*
