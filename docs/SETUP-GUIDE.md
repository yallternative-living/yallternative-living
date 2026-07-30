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

1. In Netlify: **Site Settings → Domain Management → Add Custom
   Domain** → enter `yallternativeliving.com` → copy the 4 nameservers
   shown (e.g. `dns1.p01.nsone.net`).
2. In Porkbun: **Domain Management → yallternativeliving.com → Details
   → edit Nameservers** → paste the 4 Netlify values → **Submit**. It
   can take a little while for the new address to work everywhere —
   usually under an hour, sometimes up to 48.

**C. Connect Netlify and GitHub for logins (one-time)**

One switch, nothing to copy — but skip it and Step 9's "Log in with
GitHub" won't work.

1. In Netlify: **Site configuration → Identity** (or search "OAuth") →
   **Git Gateway / OAuth** → enable **GitHub**, authorize when prompted.

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
   → choose the event `checkout.session.completed` → copy the
   **Signing secret** (`whsec_...`).

**B. Cloudflare account — you create it, I set it up**

Cloudflare runs the code that actually charges the card. It holds your
Stripe key, so it needs to be your account, not mine.

1. Sign up free at [Cloudflare](https://dash.cloudflare.com/sign-up)
   with your own email.
2. **Manage Account → Members → Invite** → my email. That lets me work
   inside your account without it ever becoming mine — remove my
   access any time.
3. Send me your **Secret key** and **Signing secret** from Part A. Wait
   for me to confirm it's connected, then move to Part C.

**C. Test, then go live**

1. Run a test purchase — one regular product and one gift card — with
   [Stripe's test cards](https://docs.stripe.com/testing). Confirm it
   reaches the thank-you page and the gift-card email arrives.
2. Switch Stripe to **Live Mode** (same toggle) and send me the
   **live** Secret key to swap in.

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

1. Sign up free at [Resend.com](https://resend.com) → **API Keys →
   Create API Key** → copy it (`re_...`).
2. In Netlify: **Site Settings → Environment Variables** → add three
   values: the **Secret key** and **Signing secret** from Step 3, plus
   this Resend key. Just pasting, nothing technical — the gift-card
   email turns itself on once all three are filled in.

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

Once Step 2C is done and the site is live, everything below is yours to
edit at `yallternativeliving.com/admin/` — no code, no file edits.

1. Visit `/admin` → **Log in with GitHub**.
2. **⚙️ Site Settings & Integrations:**
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
