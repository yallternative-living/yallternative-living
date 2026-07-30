# Y'allternative Living — website

A fast, dependency-free, static website for **Y'allternative Living**
(Landrum, SC) — handmade salves, soaks, body care and apparel, sold on
Etsy and at Upstate SC farmers markets / Pride events.

## 🌸 Savanna's Quick-Start Guide

Hey Savanna! Welcome to your website. I put this quick guide together at the top of the README to make it super easy for you to manage the shop, update content, and get everything hooked up for launch without having to dig through a bunch of code.

### 1. How to Edit Your Products, Events & FAQs (No Code Required)
I've set up a simple **Website Dashboard** where you can edit the site's content using friendly forms (so you never have to touch a text editor or type any code):
* **Where to go:** `https://<your-deployed-domain>/admin` (this link will work once the site is live)
* **What you can do here:**
  * **Products:** Add new items, change prices, update descriptions, ingredients, or inventory levels.
  * **Markets & Events:** Add upcoming market dates or move past dates to "recent appearances."
  * **FAQ List:** Change the customer questions and answers.
  * **Shop Info:** Edit the shop description or banner texts.
* **How it works:** When you make changes and click **Save**, the system automatically sends the updates to the website. The live site will rebuild and update itself in about a minute or two.
* **For technical setup (if you want me to walk you through it):** See [Section 20 (CMS Auth Setup)](#20-product-editor-sveltia-cms-at-admin-explained).

### 2. Checklist to Launch Your Store (Linking Your Tools)
To start taking payments, sending newsletters, or moderating reviews directly on the site, you'll need to create accounts on these external platforms and link them to the site. **For the click-by-click version of every step below (exact menu paths, a fill-in-the-blank handoff sheet at the end), see [docs/SETUP-GUIDE.md](SETUP-GUIDE.md)** — this list is just the summary.
1. **[ ] Hosting & Domain (Netlify):** Connect your GitHub account to host the site for free and point your custom domain. (Setup steps in [Section 12](#12-deployment)).
2. **[ ] Customer Checkout & Credit Cards (Stripe + Cloudflare):** Two accounts, not one — but you create both yourself, same as everything else on this list. **(a)** Sign up for Stripe and grab a secret key — same as any account here. **(b)** Sign up for Cloudflare too, then invite me in as a Member. That key doesn't do anything by itself: it has to be installed on a small piece of backend code (`workers/checkout.js`) that also has to be *deployed* inside your Cloudflare account using a command-line tool called Wrangler — that part is genuinely my job, not a form to fill out. Ask me to run it once you've invited me in. (Full steps in [Section 8](#8-the-shopping-system-explained) and `workers/README.md`.)
3. **[ ] Email Newsletters (Kit):** Collects customer email addresses from the signup box in the footer so you can send them updates. (Setup steps in [Section 13](#13-newsletter-signup-explained)).
4. **[ ] Contact Form, Customer Reviews & Restock Alerts (Formspree):** Create three separate forms — contact messages, new customer reviews, and "email me when it's back" signups from sold-out products — each sent directly to your email inbox. (Setup steps in [Section 16](#16-on-site-review-submissions-explained)).
5. **[ ] Gift Card Emails (Resend):** Required for the built-in gift-card system (item 2's checkout Worker uses it) to actually email a redeemable code once someone buys one — not optional unless you replace gift cards entirely with item 6. (Setup steps in `workers/README.md`.)
6. ~~Digital Gift Cards — optional upgrade (Gift Up!)~~ **Not usable yet — nothing to do here.** A possible future paid alternative to item 5's built-in system, but the code that would actually switch to it was never finished, so its CMS field is hidden (`widget: hidden` in `admin/config.yml`) rather than shown-but-unusable. See [Section 18](#18-digital-gift-cards-explained) for the honest status check.
7. **[ ] Customer Live Chat (Tawk.to - Optional):** Adds a small chat bubble to the bottom of the pages so customers can ask you questions. (Setup steps in [Section 19](#19-live-chat-explained)).
8. **[ ] Store Management (Sveltia CMS):** Log in to your secure admin panel using your GitHub account to manage products and content — requires turning on GitHub login in Netlify first, one checkbox, see [Section 20](#20-product-editor-sveltia-cms-at-admin-explained).

### 3. Setting Up Your Website Name (Domain Name)
When you're ready to buy your own custom web address (like `yallternativeliving.com`), just let me know. I've already wired up a script that will automatically update the entire site to use your new address in one click. You or I can follow the steps in [Section 10](#10-seo--ai-agent-optimization-already-in-place) to run it!

---

This file is both **maintenance documentation** for whoever edits the
site later, and the **build spec** every page in the site follows, so
keep it in sync if you change the design system.

---

## 1. Brand facts (source: the business's own Facebook page & Etsy shop)

- **Name:** Y'allternative Living
- **Positioning:** Queer-owned • Southern-raised • Alt-inspired. "Handmade
  self-care. Scrubs, soaks & scents for the black sheep & bold hearts.
  Taking up space & smelling AMAZING."
- **Location:** Landrum, SC (Upstate South Carolina). Sells at local
  farmers markets and Pride events (e.g. Upstate Pride).
- **Founder:** Savanna
- **Email:** y.allternative.living@gmail.com
- **Etsy shop:** https://www.etsy.com/shop/YallternativeLivinCO — 4.9★ (32 reviews), 105+ sales
- **Facebook:** https://www.facebook.com/p/Yallternative-Living-61577943406316/ (308 followers)
- **Instagram:** https://www.instagram.com/yallternativeliving
- **TikTok:** https://www.tiktok.com/@yallternativeliving
- **Voice:** warm, funny, a little irreverent, proudly Southern and
  proudly queer. Not corporate. Think "goth meets Southern meets your
  favorite cousin who makes soap." Never mock the customer; the edge is
  self-aware, not mean.

All product names/prices/images live in `assets/data/products.json` —
the real, canonical, hand/CMS-edited catalog (edit it directly, or
through the no-code product editor at `/admin`, see section 20) — and
were pulled directly from the shop's live Etsy listings.
`assets/js/products-data.js` is the exact same data, auto-generated by
`scripts/build-site-data.js` and wrapped in a `window.YL_PRODUCTS = ...`
assignment so the site actually loads it with zero network request and
zero fetch()/CORS complications, even off `file://` — **never hand-edit
that file directly**, your changes will just get overwritten the next
time the build script runs.

## 2. File structure

```
site/
  index.html          Home
  shop.html            Full 15-product catalog with category filters + sort
  events.html          Markets, fairs & Pride pop-ups (upcoming + past)
  about.html           Brand story / founder note
  contact.html         Contact, socials, where to find us in person
  privacy.html         Plain-language privacy policy (see section 14)
  404.html             Custom not-found page
  thank-you.html        Order confirmation page -- Stripe Checkout's
                         success_url target (section 8)
  sw.js                 Service worker: offline caching, precache list
  site.webmanifest
  robots.txt           Explicitly allows major AI crawlers too (section 10)
  sitemap.xml          Auto-generated -- see scripts/build-site-data.js
  llms.txt             AI-agent-facing summary -- auto-generated (section 10)
  netlify.toml         Netlify config: headers, caching, CSP
  vercel.json          Vercel config: same headers/CSP as netlify.toml
  .gitignore
  .github/workflows/deploy-pages.yml   GitHub Pages auto-deploy (runs the
                                        build command below first)
  admin/index.html      Sveltia CMS loader (section 20) — the no-code
                         product editor Savanna uses instead of a text editor
  admin/config.yml       Sveltia CMS field schema, mapped 1:1 to
                         products.json's real fields (section 20)
  scripts/build-site-data.js   Regenerates every derived file (including
                                products-data.js itself) from products.json
                                / events-data.js (section 10)
  scripts/build-security-headers.js  Regenerates _headers/vercel.json/
                                      netlify.toml's CSP + security headers
  scripts/optimize-images.js   Generates responsive WebP variants +
                                assets/js/image-manifest.js (section 15)
  package.json          Dev-time only (sharp, for optimize-images.js) --
                         never ships to the live site, see section 15
  workers/checkout.js   Cloudflare Worker: creates the Stripe Checkout
                         Session the on-site cart hands off to (section 8) --
                         needs to be deployed separately, see workers/README.md
  workers/submit-form.js  Optional Cloudflare Worker alternative to Formspree
                           (section 16) -- not deployed by default
  netlify/functions/fulfill-gift-card.js  Stripe webhook: emails a
                         redeemable code once a gift-card order completes
                         (section 8/18) -- also needs separate setup
  assets/
    css/styles.css     Single shared stylesheet (design tokens + components,
                        @font-face rules)
    css/cart.css       On-site cart drawer styling (section 8)
    fonts/*.woff2      Self-hosted Fraunces + Figtree (section 15)
    js/main.js         Shared behavior: theme toggle, mobile nav, scroll
                        reveal, product card + <picture> rendering,
                        filters/sort, wishlist, Add to Cart button builder
    js/cart.js         The on-site cart engine + drawer (section 8) --
                        talks to workers/checkout.js, hands off to Stripe
    js/thank-you.js    Order-confirmation page logic (thank-you.html only)
    js/products-data.js  AUTO-GENERATED from data/products.json -- product
                          catalog as a JS global (window.YL_PRODUCTS).
                          Don't hand-edit (section 20).
    js/events-data.js    Upcoming/past events as a JS global (window.YL_EVENTS)
    js/site-reviews-data.js  Hand-curated, site-submitted reviews (section 16) --
                              starts empty, never auto-populated
    js/image-manifest.js  Auto-generated -- maps each photo to its WebP
                           variants (section 15). Don't hand-edit.
    data/products.json   THE real, canonical catalog (products, bundles,
                         FAQ, shop info) -- edit directly or via /admin
                         (section 20); everything else derives from this
    img/*.jpg            Real product photos + logo, pulled from the
                          shop's own Etsy listings
    img/*.webp           Auto-generated responsive variants (section 15)
```

No build step for the deployed site itself: open `index.html` in a
browser and it works, and you can deploy by dragging the `site/` folder
onto Netlify/Vercel/GitHub Pages or uploading via any host's file
manager. There is now one *optional, dev-time-only* tool (`npm install`
+ `scripts/optimize-images.js`, see section 15) for regenerating
responsive photo variants -- it never touches how the live site loads,
it just pre-generates files that get deployed alongside everything else.

**Code style (dev-time only, also optional):** `npm install` also pulls
in ESLint and Prettier for the hand-written JS in `scripts/` and
`assets/js/`. Neither is required to edit or deploy the site, but both
run in CI (`.github/workflows/test.yml`) alongside `npm test`, so a PR
that introduces a real lint error or an unformatted file will show a
failing check.

```
npm run lint            # ESLint, scripts/ + assets/js/
npm run format           # Prettier, writes fixes in place
npm run format:check     # Prettier, fails without writing (what CI runs)
```

Both are scoped to `scripts/**/*.js` and `assets/js/*.js` only --
HTML, CSS, JSON, and markdown in this project are intentionally left to
hand-formatting, not Prettier's opinions.

## 3. Design system (do not hand-roll new colors/fonts — use these)

Everything routes through CSS custom properties in `assets/css/styles.css`,
themed for **dark (default) and light mode** via `[data-theme]` + a
`prefers-color-scheme` fallback, toggled with zero flash by `main.js`.

- `--ink / --ink-2 / --ink-3` — background layers (elevated dark grey in
  dark mode, warm paper in light mode — never pure `#000`/`#fff`)
- `--paper / --paper-dim` — text (primary / muted)
- `--hide` — hairline borders (leather brown)
- `--whiskey` / `--whiskey-dim` — amber accent
- `--rose` / `--rose-dim` — wine/rose accent (primary CTA color)
- `--pride` — 6-stop rainbow gradient, used **sparingly** as a small
  accent (underline on the active nav link, a rule under the hero) —
  never as a full background wash
- `--font-display` (Fraunces, a warm variable serif) for all headings;
  `--font-body` (Figtree, a warm humanist sans) for everything else.
  Fraunces replaced an earlier choice (Rye, a wood-type western/saloon
  face) that read as Texas/Wild-West-coded rather than
  Upstate-SC-Southern. Figtree replaced Jost for the body font -- Jost
  is a fine typeface, but it's become the default "indie brand starter
  kit" sans on Squarespace-style sites, which cut against the goal of
  not reading as templated.
- Layout: `.container` (max 1320px), `section` (88px vertical rhythm),
  `.grid.grid-3` / `.grid-4` for card grids
- Components already built: `.btn` (`.btn-primary` / `.btn-outline` /
  `.btn-ghost`, `.btn-sm`), `.card` (product card), `.quote-card`
  (testimonial), `.tag`, `.value-item`, `.filter-pill`, `.field` (forms)
- `.reveal` class + `main.js`'s IntersectionObserver = fade/slide-in on
  scroll. Add `.reveal` to any section child you want animated in.
- Page-specific one-off styling belongs in a `<style>` block at the
  bottom of that page's `<head>`, scoped with a page-prefixed class
  (e.g. `.about-*`, `.contact-*`) — never edit shared tokens per-page.

## 4. Required `<head>` boilerplate (every page)

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="view-transition" content="same-origin">
<title>PAGE TITLE — Y'allternative Living</title>
<meta name="description" content="PAGE-SPECIFIC 150-160 CHAR DESCRIPTION">
<!-- No live domain yet -- once deployed, add: <link rel="canonical" href="https://your-domain-here.com/PAGE.html"> -->

<meta property="og:type" content="website">
<meta property="og:title" content="PAGE TITLE — Y'allternative Living">
<meta property="og:description" content="PAGE-SPECIFIC DESCRIPTION">
<meta property="og:image" content="assets/img/unisex-tshirt.jpg">
<!-- og:url -- add once deployed: <meta property="og:url" content="https://your-domain-here.com/PAGE.html"> -->
<meta name="twitter:card" content="summary_large_image">

<link rel="icon" href="assets/img/favicon-32.png" sizes="32x32" type="image/png">
<link rel="icon" href="assets/img/favicon-192.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="assets/img/apple-touch-icon.png">
<link rel="manifest" href="site.webmanifest">
<meta name="theme-color" content="#c65a6d">

<!-- Fonts are self-hosted (assets/fonts/) -- see @font-face rules in
     assets/css/styles.css. Preloading the primary weight of each
     avoids a flash of invisible text on first paint. -->
<link rel="preload" as="font" type="font/woff2" href="assets/fonts/fraunces-normal.woff2" crossorigin>
<link rel="preload" as="font" type="font/woff2" href="assets/fonts/figtree-normal.woff2" crossorigin>
<link rel="stylesheet" href="assets/css/styles.css">

<script>
  // No-flash theme init: runs before paint, before main.js.
  (function(){
    var t = localStorage.getItem('yl-theme');
    if(!t){ t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; }
    document.documentElement.setAttribute('data-theme', t);
  })();
</script>
<!-- + a page-specific LocalBusiness / BreadcrumbList JSON-LD <script type="application/ld+json"> block -- see any existing page's <head> for the pattern. -->
</head>
```

## 5. Required scripts + header (right after `<body>`, on every page)

No inline cart script needed anymore — the on-site cart (`cart.js`) is a
regular `defer`red script tag alongside the others near the end of the page
(see section 8), not something that has to load first. `<body>` just opens
straight into the skip link and header. Swap the `class="active"` onto
whichever nav link matches the current page; the others should have no
`active` class.

```html
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <nav class="nav">
    <a class="brand" href="index.html" aria-label="Y'allternative Living home">
      <img src="assets/img/logo.jpg" alt="Y'allternative Living logo" width="42" height="42">
      <span class="brand-word">Y'allternative<small>Living</small></span>
    </a>
    <ul class="nav-links" id="navLinks">
      <li><a href="index.html">Home</a></li>
      <li><a href="shop.html">Shop</a></li>
      <li><a href="events.html">Events</a></li>
      <li><a href="about.html">Our Story</a></li>
      <li><a href="contact.html">Contact</a></li>
    </ul>
    <div class="nav-cta">
      <button class="cart-toggle" type="button" aria-label="View your cart">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.5 3h2l2.6 12.6a2 2 0 0 0 2 1.6h8.4a2 2 0 0 0 2-1.6L21 8H6"/></svg>
        <span class="badge cart-count"></span>
      </button>
      <button type="button" class="theme-toggle" id="themeToggle" role="switch" aria-checked="false" aria-label="Toggle dark and light mode">
        <span class="knob">🌙</span>
      </button>
      <a class="btn btn-primary btn-sm" href="https://www.etsy.com/shop/YallternativeLivinCO" target="_blank" rel="noopener"><span>Shop</span> Etsy ↗</a>
      <button type="button" class="nav-toggle" aria-label="Open menu" aria-expanded="false">☰</button>
    </div>
  </nav>
</header>
<main id="main">
```

Note the wishlist heart icon isn't in this markup — it's injected at
runtime by `main.js` (`initWishNavButton`) as the very first child of
`.nav-cta`, so on a live page the final left-to-right order is: heart
(wishlist) → cart (opens the on-site cart drawer) → theme toggle →
"Shop Etsy" → hamburger. You never need to hand-add the heart button.

## 6. Required footer + closing scripts (every page, before `</body>`)

**The footer is single-source now — don't hand-edit it on individual
pages.** The entire `<footer class="site-footer">...</footer>` block is
byte-identical across all 7 pages, so it lives in exactly one file,
`assets/data/footer.html` (everything *inside* the `<footer>` tag —
the outer tag itself is added by the build). To change anything in the
footer (a new social link, the real Kit newsletter form URL, a policy
tweak, an added tracking snippet), edit `assets/data/footer.html` once,
then run:

```
npm run build-data
```

That regenerates `index.html`, `shop.html`, `about.html`, `contact.html`,
`events.html`, `privacy.html`, and `404.html` by replacing each page's
existing `<footer class="site-footer">...</footer>` block wholesale with
the current contents of `assets/data/footer.html`. No per-page marker
comments are needed — the replacement regex anchors on the
`site-footer` class, so the small `<footer>` tags inside review
quote-cards are never touched. The copyright year is still filled in
live by `main.js` (`getFullYear()`), so it stays correct without a
yearly rebuild.

If you're adding a brand-new page that doesn't exist yet, add its
filename to the page list inside `scripts/build-site-data.js`'s
"4b) shared footer" step so it gets the footer injected too, and make
sure the page has a `<footer class="site-footer">` placeholder (even an
empty one) for the build to find and replace.

The closing `<script>` tags stay hand-written on each page, right
after the footer, before `</body>`:

```html
<script src="assets/js/products-data.js" defer></script>
<script src="assets/js/image-manifest.js" defer></script>
<script src="assets/js/main.js" defer></script>
<script src="assets/js/cart.js" defer></script>
</body>
</html>
```

Notes:
- `<main id="main">` opens in the header block above and is closed
  right before the footer — everything page-specific goes between them.
- Every internal link inside the footer is a relative path
  (`shop.html`, not `/shop.html`) so the site works from a subfolder or
  `file://` with no server.
- These `<script>` tags are required on every page — `products-data.js`
  and `image-manifest.js` are the catalog + responsive-image data,
  `main.js` powers the theme toggle, mobile nav, scroll reveal, and (on
  `index.html`/`shop.html`) the product grid, and `cart.js` is what makes
  the Add to Cart buttons and cart drawer actually work (section 8) —
  leaving it off a new page means clicking Add to Cart there does nothing.
  You'll also need `<link rel="stylesheet" href="assets/css/cart.css">` in
  the `<head>` alongside `styles.css` (section 4) for the drawer to be
  styled instead of unstyled HTML.

## 7. Content already researched (use real facts, never placeholders)

15 real products across 5 categories (apparel, salves & balms, body &
skin, soaks, potions & spellwork) — full list with prices, blurbs and
Etsy links in `assets/data/products.json` (the canonical source, editable
by hand or via `/admin` — see section 20). Two real Etsy review
snippets worth quoting on the homepage:

> "second purchase, works well. good scent." — Eric, Etsy review
> "Smells GREAT! Haven't tried it yet, but look forward to using it :)" — Leese, Etsy review

Shop stats: **4.9★ average, 32 reviews, 105+ sales, 1 year on Etsy.**

## 8. The shopping system, explained

The site sells directly — a real "Add to Cart" button, a real on-site cart,
and a real checkout — using an **on-site cart the site owns**
(`assets/js/cart.js`) that hands off to **[Stripe Checkout](https://stripe.com/payments/checkout)**
(Stripe's own hosted payment page) for the actual card entry. This replaced
Snipcart (see `docs/STRIPE-MIGRATION.md` for the full history of that switch)
specifically to drop Snipcart's $20/month minimum — Stripe only charges a
per-transaction fee (2.9% + 30¢), nothing monthly. Etsy stays visible
everywhere as a trust signal (reviews, sale count, a direct listing link on
every product) but is no longer the only way to buy.

**What's already wired in:**

- Every product card (`cardHTML()` in `main.js`) renders a primary
  **"Add to Cart"** button (class `yl-add-item`, built by the
  `addToCartHTML()` helper) plus a small secondary **"or view the
  listing on Etsy ↗"** link underneath, so Etsy stays the credibility
  signal without being the checkout path.
- A cart icon next to the wishlist heart in the nav (`.cart-toggle`) opens
  the cart drawer; it shows a live item count via the `.cart-count` badge.
- Clicking Add to Cart opens a slide-out drawer (`cart.js`, styled by
  `assets/css/cart.css`) showing every line item, a free-shipping progress
  meter, one-click upsells, and a Checkout button. Everything is stored in
  the visitor's own browser (`localStorage`) until they check out — no
  account, no backend, syncs across open tabs.
- The **"Saved For Later"** wishlist drawer (heart icon on every
  product card; saves to the visitor's own browser via `localStorage`,
  key `yl-wishlist` — separate from the cart) has its own "Add to
  Cart" button per saved item, plus a "View Cart & Checkout" button at
  the bottom, so saving something and buying it later both happen
  without leaving the site.
- Clicking Checkout POSTs the cart to a small backend piece (a Cloudflare
  Worker, `workers/checkout.js`) that re-derives every price from
  `assets/data/products.json` itself — it never trusts whatever price the
  browser sent — then redirects to a real Stripe-hosted payment page. Order
  confirmation happens on `thank-you.html`.
- Order-integrity note: since prices are re-derived server-side from
  `assets/data/products.json` on every checkout attempt, there's no
  separate manifest file to keep in sync (unlike Snipcart's old
  `snipcart-products.json`) — **any time you change a price** in the
  Website Dashboard (`/admin`) or by hand-editing `products.json`, the
  next build (`node scripts/build-site-data.js`) picks it up automatically
  and the very next checkout charges the new price. Nothing extra to
  remember.
- Gift cards are a special case: buying one triggers a second backend piece
  (`netlify/functions/fulfill-gift-card.js`) that emails the recipient a
  redeemable code once payment actually completes, using
  **[Resend](https://resend.com)** to actually send that email (a separate
  free account/API key from Stripe -- see Part B below). See section 18.
- Shipping: a flat $10 charge applies below a $40 order subtotal, free above
  it (matches the "Free shipping on orders over $40" banner already on
  every page). This is a hardcoded starting default in `workers/checkout.js`
  (look for `freeShippingThresholdCents`/`flatShippingRateCents` near the
  top) — Snipcart used to own this from its own dashboard; there's no
  dashboard here, so adjust those two numbers directly in the file if real
  rates differ, then redeploy the Worker.
- Taxes: **built, but switched off until someone turns it on.**
  `workers/checkout.js` supports Stripe Tax behind a `STRIPE_TAX_ENABLED`
  Worker variable, and ships with it off. Why off by default and not just
  always on: Stripe Tax only collects where you hold an active registration,
  and calling it before Stripe Tax is activated on the account makes Stripe
  **reject the entire Checkout Session** — so a premature "on" doesn't
  quietly skip the tax line, it breaks every purchase. Turning it on is
  therefore a two-part job, and the paperwork half has to come first:

  1. **In the Stripe Dashboard** (Savanna, or whoever handles the business's
     taxes): set a head-office address under Tax → Settings, then add a
     registration under Tax → Registrations for South Carolina — and any
     other state where enough sales accumulate to create an obligation.
     Stripe's Tax → Monitoring page watches those thresholds for you.
     Whether a registration is required at all is a real tax question, not a
     technical one, and worth asking an accountant rather than guessing.
  2. **Then, in Cloudflare** (Steven): set the Worker variable
     `STRIPE_TAX_ENABLED = "true"` and redeploy. Nothing else changes.

  Once on, the Worker sends `automatic_tax[enabled]=true`, creates a Customer
  so Stripe has an address to rate against, marks every price
  tax-exclusive (site prices are pre-tax), and tags each line with a real
  product tax code instead of leaning on the account default: gift cards
  `txcd_10502000`, apparel `txcd_30011000`, everything else
  `txcd_99999999`, with shipping tagged `txcd_92010001` so states that tax
  delivery charges get it right. Stripe Tax is a paid add-on — check
  [current pricing](https://stripe.com/tax/pricing) before flipping it on.

  **Which address the rate comes from:** South Carolina uses
  destination-based sourcing — the rate follows the point of delivery, not
  the seller's location, and that includes local county add-ons of 1–3% on
  top of the 6% state rate. So an order shipped to Charleston is rated at
  Charleston's combined rate, not Landrum's. This works correctly already:
  the Worker collects a shipping address whenever the order contains
  physical goods, and Stripe rates against it. Orders shipped outside SC are
  rated at 0% unless a registration exists for that state, which is the
  correct outcome for a business with nexus only in SC.

  *Market pickup is handled too.* A pickup order is delivered at the market,
  so that county's rate applies — not the buyer's home county. Stripe's
  purpose-built feature for this (performance locations) isn't supported by
  Checkout Sessions, so the Worker takes the route that is: it creates a
  Stripe Customer already carrying the market's address, passes that
  `customer` to the session, and skips collecting a shipping address
  (a collected one always wins over the Customer's). `customer_update
  [address]=never` stops the billing address from displacing it afterward.

  For this to work, the market needs a **ZIP code** filled in under
  *Markets, Fairs & Pride Dates* in the CMS — Stripe needs country, state,
  and a 5-digit ZIP to resolve a US jurisdiction. The state is read off the
  end of the `location` string (`"Flat Rock, NC"` → `NC`), so out-of-state
  markets work without a separate field.

  Every failure here degrades to the ordinary buyer-address flow rather than
  blocking a sale: no ZIP recorded, a `pickupMarket` label that doesn't match
  the calendar, `events.json` unreachable, or the Customer create failing.
  The label is re-derived server-side from `events.json` and compared, never
  trusted — the same rule prices follow — so a forged label can't pin an
  order to a cheaper jurisdiction. All of these paths are covered in
  `scripts/backend-functions.test.js`.

  One coupling to know about: `pickupLabelFor()` in `workers/checkout.js`
  must stay byte-identical to the `<option>` label cart.js builds for the
  pickup dropdown. Change one and change the other; the test suite pins both.

  **Discounts and tax together:** Stripe rates the subtotal *after*
  discounts, which is the right answer for this site's own markdowns — a
  bundle's `discountPercent` and the custom box's 10% are already baked into
  the price sent to Stripe, and a sale price is a genuinely lower price, so
  tax should follow it down. The imperfect case is gift cards: see
  [Section 18](#18-digital-gift-cards-explained).

**What you (Savanna) still need to do — I can't do this part for you,
since it requires creating an account and entering real payment details,
and none of it could be tested against a real Stripe account in the
environment this was built in.**

**A. Stripe account**

1. [Sign up for a Stripe account](https://dashboard.stripe.com/register)
   (no fee to sign up; you only pay the per-transaction rate once you're
   live). Stripe starts you in **Test mode** — a toggle in the dashboard —
   where nothing touches a real card until you flip it.
2. Under **Developers → API keys**, grab a **secret key**. A *restricted*
   key limited to Checkout Sessions + Coupons + Promotion Codes write
   access is safer than the default full-access secret key, if you want to
   set that up.

**B. Deploy the two backend pieces**

This is the part that's more setup than Snipcart used to be (Snipcart
needed zero servers; Stripe Checkout needs these two small pieces to create
sessions and handle gift cards) — but full step-by-step instructions are in
`workers/README.md`, written for exactly this handoff:

3. Deploy `workers/checkout.js` to Cloudflare Workers (free tier is plenty
   for a shop this size) with your Stripe secret key and site domain.
4. Sign up for a free **[Resend](https://resend.com)** account and grab an
   API key -- this is what actually sends the gift-card email, and it's
   easy to miss since it's not a Stripe or Netlify product. Set the three
   environment variables `fulfill-gift-card.js` needs in Netlify's site
   settings (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and
   `RESEND_API_KEY`), then register the function as a Stripe webhook
   endpoint (Developers → Webhooks in the Stripe Dashboard) so gift cards
   actually get emailed.

**C. Store details**

5. **Currency** — every price on the site (and the `priceCurrency: "USD"`
   already in the JSON-LD) assumes USD; nothing to configure on Stripe's
   side for a US-only shop.
6. **Notification email** — Stripe's dashboard sends its own payment
   receipts/notifications automatically once live; check
   **Settings → Business settings → Public details** for the name/email
   customers see.

**D. Growth features (optional, but worth doing — see
`website-gap-analysis.md`)**

7. **First-order discount code** — Stripe supports Coupons + Promotion
   Codes directly (the same mechanism `fulfill-gift-card.js` already uses
   for gift-card redemption codes) — create one in
   **Product catalog → Coupons**, and since `workers/checkout.js` already
   sets `allow_promotion_codes: true`, any code you create there is
   immediately usable at checkout with no code changes.
8. **Abandoned cart recovery** — Stripe doesn't have Snipcart's built-in
   abandoned-cart email sequence. This would need to be built separately
   (e.g. a scheduled check against `localStorage`-persisted carts isn't
   possible server-side since carts never leave the browser until checkout
   — a real abandoned-cart feature would need its own design).

**E. Before trusting this with real money**

9. Run a full test-mode purchase end to end — regular product, a product
   with variants, and a gift card — using
   [Stripe's test card numbers](https://docs.stripe.com/testing). Confirm
   the order redirects to `thank-you.html` correctly, and confirm the
   gift-card webhook actually fires and the email arrives with a working
   code (this specifically could not be verified in the sandbox this was
   built in — it's the one piece that genuinely needs a live test).
10. Only after that: swap in your **live** Stripe secret key on the Worker
    and re-deploy.

Etsy still fully works as a second sales channel in parallel — nothing
here removes or blocks the "or view the listing on Etsy" links.

## 9. Events page — how to add a market or fair

`events.html` reads from `assets/js/events-data.js`. To add a real,
confirmed date:

1. Open `assets/js/events-data.js`.
2. Copy one of the example objects inside `upcoming: [ ... ]`.
3. Fill in `date` (YYYY-MM-DD, used for sorting), `dateLabel` (however
   you want it displayed), `name`, `type`, `location`, and optionally a
   `url` (an event page, Facebook event, etc.).
4. Save. The page picks it up automatically — no other file changes
   needed.

Only put confirmed dates in `upcoming` — real customers may plan to
show up in person. When a market or fair has passed, move its object
into the `past: [ ... ]` array instead (drop the `date`/keep a
`dateLabel`) so it becomes a "Recent Appearances" entry.

## 10. SEO + AI-agent optimization, already in place

**Traditional SEO:**

- Unique `<title>`, meta description, canonical URL, and Open Graph /
  Twitter card tags on every page.
- `LocalBusiness` structured data (JSON-LD) on every page, and
  `BreadcrumbList` structured data on every inner page.
- A full `Product`/`ItemList` JSON-LD block on `shop.html` covering all
  15 listings (name, image, price, category, and a direct link to buy)
  — this is what lets Google show rich product results.
- `FAQPage` structured data on `contact.html`, generated from the real
  Q&A copy already on that page (not invented separately — if you edit
  the visible FAQ text, update the matching JSON-LD block right above
  it in the `<head>` so they stay in sync, same as any other duplicated
  content on this site).
- `sitemap.xml` and `robots.txt` at the site root.
- Semantic heading hierarchy (one `<h1>` per page), descriptive `alt`
  text on every image, and `fetchpriority="high"` on each page's
  above-the-fold hero image for faster perceived load.

**AI-agent optimization (2026):** this is a small business that *wants*
visibility, so the approach here is "make it easy for AI to find and
describe accurately," not "block AI crawlers":

- `robots.txt` explicitly allows the major AI crawlers by name (OpenAI's
  GPTBot/OAI-SearchBot/ChatGPT-User, Anthropic's ClaudeBot/
  Claude-SearchBot/Claude-User, Perplexity's PerplexityBot/
  Perplexity-User, Google-Extended, CCBot, Bingbot) in addition to the
  wildcard `Allow: /` that already covered them — explicit rather than
  just implicit, so intent reads unambiguously to anyone auditing the
  file. If you ever want to block AI *training* specifically while still
  allowing AI *search/citation* crawlers, that's the distinction between
  e.g. `GPTBot`/`Google-Extended` (training) vs. `OAI-SearchBot`/
  `Claude-SearchBot`/`Perplexity-User` (live answer citations) — for now
  all are allowed.
- **`llms.txt`** at the site root — a plain-Markdown summary of the
  business, its pages, and its full product catalog, following the
  community "llms.txt" convention for helping AI assistants/agents
  describe a site accurately instead of guessing (not an official
  W3C/IETF standard as of mid-2026, but real, growing adoption). It
  explicitly tells AI readers to treat `assets/data/products.json` as
  the live source of truth for pricing, and explicitly warns against
  reading product names like "Miracle" or "Heal" as medical claims.

**Auto-adapt pipeline — the important part:** almost everything above
that mentions specific products (the shop JSON-LD, `products-data.js`,
`llms.txt`'s product list) is **generated, not hand-written** by
`scripts/build-site-data.js`. Run this one command from inside `site/`
any time you add, edit, or remove a product (or add a new top-level page):

```
node scripts/build-site-data.js
```

It regenerates everything derived from the four canonical source files
in `assets/data/` — `products.json`, `events.json`, `site-reviews.json`,
and `content.json` (the single source of truth for each — see section
20 for how they're edited): `assets/js/products-data.js`,
`events-data.js`, and `site-reviews-data.js`; `shop.html`'s Product/ItemList
JSON-LD block; `contact.html`'s FAQPage JSON-LD + visible FAQ prose;
`index.html`/`about.html`'s page copy; every page's shared `<footer>`
(see section 6); `sitemap.xml`; `robots.txt`; and `llms.txt`. It's safe
to run as many times as you want — it only ever overwrites those
generated files, never the four source JSON files themselves, your
copy, or your photos. This is the SQL-style single-source-of-truth
pattern: edit a data file once (by hand or via `/admin`), run one
script, everything downstream updates.

**Why the direction flipped mid-project:** earlier versions of this site
had it backwards — `products-data.js` was canonical and `products.json`
was the generated copy. That changed once the Sveltia CMS product editor
(section 20) entered the picture: a CMS can only write plain JSON/YAML,
not a hand-rolled `.js` file with a `window.YL_PRODUCTS = ...` wrapper,
so `products.json` had to become the real source and `products-data.js`
had to become the generated one. If you're used to the old direction
from an earlier version of this README, that's the one thing to
un-learn.

There's no live domain yet, so every canonical URL, Open Graph URL, and
JSON-LD `@id`/`url`/`image` field currently uses the placeholder
`https://your-domain-here.com`, with the canonical/og:url tags
commented out entirely (an inactive `<!-- -->` hint, not a fake live
URL). **Once a real domain exists, going live is a one-line change, not
a find-and-replace:** open `scripts/build-site-data.js`, find the
`var DOMAIN = "https://your-domain-here.com";` line near the top, and
replace it with the real domain. Then run `node scripts/build-site-data.js`
once — it detects the domain is no longer the placeholder and
automatically uncomments the canonical/og:url tags, and rewrites
Plausible's `data-domain` plus every JSON-LD `@id`/`url`/`image`/
breadcrumb field to the real domain, across all 7 pages, `sitemap.xml`,
and `robots.txt`, in one pass. No manual per-file editing needed.

## 11. Updating the site later

- **Add/edit a product:** either use the no-code product editor at
  `/admin` (section 20 — the easiest path, no text editor needed and no
  build step to remember), or hand-edit the `products` array in
  `assets/data/products.json` directly (it's the single source of
  truth — never hand-edit `assets/js/products-data.js`, that file is
  auto-generated and your changes would just get overwritten). Drop a
  new photo in `assets/img/`. If you edited `products.json` by hand,
  then run `node scripts/build-site-data.js` from inside `site/` — this
  regenerates `products-data.js`, `shop.html`'s Product JSON-LD,
  `sitemap.xml`, and `llms.txt` all in one step (see section 10). (If you
  used `/admin` instead, the site's own deploy step does this for you
  automatically — see section 12 and section 20.) The checkout Worker
  (`workers/checkout.js`) re-derives every price straight from the live
  `products.json` on the deployed site at checkout time, so this isn't
  quite as strict a requirement as it used to be — but skipping the
  rebuild still means the shop page itself keeps showing the old price
  until the next deploy, which is confusing even if checkout would charge
  correctly. Treat it as a required part of editing a product by hand.
- **Add/edit an event:** either use `/admin` (section 20) or hand-edit
  `assets/data/events.json` directly, then run
  `node scripts/build-site-data.js` — this regenerates
  `assets/js/events-data.js` from it (see section 9 for the event
  fields themselves).
- **Change colors/fonts:** edit the CSS custom properties at the top of
  `assets/css/styles.css` — every page updates automatically, in both
  dark and light mode, including the on-site cart drawer (`cart.css`
  reads the same custom properties).
- **Deploy:** see section 12 below.

## 12. Deployment

**A real build command is now required** (this changed once the Sveltia
CMS product editor at `/admin` entered the picture — see section 20): a
CMS commit only updates `assets/data/products.json`, and everything
derived from it (`products-data.js`, `shop.html`/`contact.html`'s
JSON-LD, `sitemap.xml`, `llms.txt`) needs regenerating on every deploy,
not just when a human remembers to run
`node scripts/build-site-data.js` by hand. The good news: it's still
**zero `npm install`** — both `scripts/build-site-data.js` and
`scripts/build-security-headers.js` only use Node's built-in `fs`/`path`/
`crypto` modules, no external dependencies. Three ready-to-go options
are already in this folder, all pre-wired with the build command:

- **Netlify** — `netlify.toml` is already configured (the build command
  above, long-cache headers for images/CSS/JS, security headers, and a
  CSP that already allows Umami/Tawk/Google Translate + the `/admin`
  CMS — Stripe itself needs no CSP entry, see section 8). Also where
  `netlify/functions/fulfill-gift-card.js` deploys from, if you go this
  route — Netlify auto-detects that folder. Connect
  a GitHub repo for auto-deploys on every push (drag-and-drop onto
  [app.netlify.com/drop](https://app.netlify.com/drop) also still works,
  but skips the build step, so `/admin` edits won't take effect until
  you redeploy some other way — connecting a repo is the better option
  now that a CMS is in the picture). Publish directory is `.`.
- **Vercel** — `vercel.json` has the equivalent `buildCommand`,
  `outputDirectory`, headers, and CSP. Connect the repo in Vercel's
  dashboard so the build command actually runs (running `vercel` from a
  local folder without a repo connection skips it, same caveat as
  Netlify's drag-and-drop above).
- **GitHub Pages** — `.github/workflows/deploy-pages.yml` runs the build
  command, then the QA suite (informationally — it won't block a deploy
  over the one known expected failure, the domain placeholder), then
  deploys on every push to `main`. One-time setup: in the repo's
  **Settings → Pages**, set **Source** to **"GitHub Actions"** (not
  "Deploy from a branch"). After that, every push publishes
  automatically. (GitHub Pages doesn't support custom response headers,
  so the CSP/security headers only apply on Netlify or Vercel — the site
  still works fine on Pages, just without those extra headers, and
  `/admin`'s own CSP doesn't apply there either.)

**All three of these require a real GitHub repo** now that `/admin`'s
Sveltia CMS backend is GitHub-based (section 20) — if this project isn't
in a GitHub repo yet, that's the actual first step, before any of the
above.

**Checkout is a separate deploy from all three of the above, regardless
which one you pick.** `workers/checkout.js` is a Cloudflare Worker — it
deploys to Cloudflare, not to Netlify/Vercel/GitHub Pages, even if you
host the static site itself on one of those. Likewise,
`netlify/functions/fulfill-gift-card.js` specifically needs a Netlify
site to auto-deploy from (Netlify's functions convention) — if you host
the static site on Vercel or GitHub Pages instead, that one function
would need its own separate Netlify site (or a rewrite for whichever
host's own functions platform) just to run. See section 8 and
`workers/README.md` for the actual deploy steps.

Also included:

- **`404.html`** — a custom not-found page (all three hosts above
  detect this filename automatically, zero config needed).
- **`.gitignore`** — excludes OS junk files, logs, and local `.env`/
  `.vercel` folders from version control.

**Whichever host you pick, remember to also:** deploy the checkout Worker
+ gift-card webhook with real Stripe keys (section 8) and, once you have
a real domain, find-and-replace `your-domain-here.com` and uncomment the
canonical/og:url tags (section 10).

## 13. Newsletter signup, explained

Every page's footer has a real, working email signup box (`.footer-signup`)
using **[Kit](https://kit.com)**, formerly ConvertKit (free tier: 10,000
subscribers, no credit card required — chosen over Mailchimp's 500-contact
free cap and Buttondown's 100-subscriber cap, and its plain-HTML embed +
dashboard-configurable post-signup redirect need zero JavaScript to work,
matching the rest of this site's philosophy). It's a plain
`<form method="post">` that submits directly to Kit.

**What's already wired in:**

- A honeypot field (`footer_website`) that's invisible and untabbable for
  real visitors. `main.js` silently drops the submission client-side if
  it's filled in (a sign of a bot) — no account or backend needed for this.
  With JavaScript off, the field just stays blank for real people and the
  form still posts normally straight to Kit.
- A `?subscribed=1` check in `main.js`: after Kit's own post-signup
  redirect lands back on the site, the footer box swaps to a "you're on
  the list" state and the flag is cleaned out of the URL. The actual
  subscribe is a real, un-intercepted POST straight to Kit — this JS never
  fakes success, it just reacts to Kit's real redirect.
- CSP in both `netlify.toml` and `vercel.json` already allows Kit's form
  domains (`app.kit.com`, `app.convertkit.com`) via the `form-action`
  directive.
- The same signup box appears identically in the footer of all seven
  pages (including `privacy.html`), verified byte-for-byte identical.

**What you (Savanna) still need to do — I can't do this part for you,
since it requires creating an account:**

1. [Sign up for a free Kit account](https://kit.com) (no credit card
   required for the free tier).
2. In Kit's dashboard, create a Form (Grow → Landing Pages & Forms →
   Create Form). Choose the plain "Inline" or "HTML" form type.
3. In that form's settings, find the "redirect to a URL after
   subscribing" option and set it to `index.html?subscribed=1` on your
   real domain once you have one (e.g.
   `https://your-domain.com/index.html?subscribed=1`).
4. Grab the form's real HTML embed code from Kit's "Embed" tab and copy
   just its `<form action="...">` URL (looks like
   `https://app.kit.com/forms/1234567/subscriptions`).
5. Enter the form action URL in the Website Dashboard (`/admin` → Page Wording → Global Site Assets & Configurations → Kit Form Action URL) or in `assets/data/content.json` under `site.kitFormAction`. The build script will automatically propagate it to all pages.
6. Test a real signup once deployed: submit the form, confirm you land
   back on the site with the "you're on the list" message, and check
   that the email actually lands in your Kit subscriber list.

Nothing about the honeypot or confirmation JS needs to change once you do
this — they're driven entirely by the form's real action URL and Kit's
own redirect setting, not by anything hardcoded to a fake key.

## 14. Privacy policy page

**`privacy.html`** — a plain-language privacy policy, explicitly framed
as not legal advice, written to accurately reflect what this specific
site does: theme preference and the "Saved For Later" wishlist live only
in browser `localStorage` and never touch a server; the cart lives
on-site too, but checkout itself happens on a page hosted by
[Stripe](https://stripe.com) (linked out to
[Stripe's own privacy policy](https://stripe.com/privacy) rather than
restating it) — card details are entered there, never on this site's own
servers; page-view analytics run through [Umami](https://umami.is), a
cookieless analytics tool (no cookie-consent banner needed as a result);
the email newsletter signup is described generically (no specific
provider named, to stay accurate regardless of whether Kit is still the
provider); Etsy is disclosed honestly as a linked third party. No
compliance claims (GDPR/CCPA/cookie-consent) are made since none of that
machinery exists on the site — it just offers to help with rights
requests case-by-case via email. Uses the same head boilerplate,
header/footer, and JSON-LD pattern as the other six pages, linked from
every footer. Last updated 2026-07-16 — **have an actual lawyer review
this before treating it as a real legal document**, especially if the
shop starts collecting more customer data than it does today (e.g. if
Stripe's dashboard is configured to also handle marketing consent, or if
a database of customer order history gets added later).

## 15. Performance: responsive images + self-hosted fonts

Two changes, both aimed at real Core Web Vitals wins, not just theory:

**Responsive AVIF & WebP images.** Image assets now render as optimized
`<picture>` elements serving next-generation AVIF (with WebP fallback) to phones and desktops.
* **Product Photos:** Rendered dynamically at runtime by `pictureHTML()` in `assets/js/main.js` reading from the manifest.
* **Static Editorial Images (hero, bio, logos, etc.):** Compiled and statically injected at build time by `node scripts/build-site-data.js` parsing clean outer HTML comments (e.g., `<!--YL:home.heroImage-->...<!--/YL:home.heroImage-->`).
* **Format & Skip Support:** Supports JPEGs and PNGs. The optimizer (`scripts/optimize-images.js`) caches processed images and runs in milliseconds on subsequent builds by comparing file sizes, completely avoiding deployment timeouts. Real stats: AVIF brings up to **89% smaller** payloads for mobile devices!

**How to add a new photo and keep this working:**
```
1. Drop the new .jpg or .png into assets/img/ (or upload it via /admin).
2. Run node scripts/build-site-data.js (rebuilds data and wires static images).
3. npm run optimize-images   (or: node scripts/optimize-images.js to generate the modern variants; it only processes new/modified files).
```
That's it — the new photo gets the same responsive treatment
automatically. If step 3 never happens, nothing breaks: the site falls back to the original image path for any image missing from the manifest.
`sharp` (the only dependency, see `package.json`) is dev-time only and
never ships to the deployed site.

**Self-hosted fonts.** Fraunces and Figtree are no longer loaded from
Google Fonts. Both are real variable fonts (one file covers the whole
weight range, and Fraunces's optical-size axis too), pulled once as
`.woff2` files into `assets/fonts/`, with `@font-face` rules declared
directly in `assets/css/styles.css`. This removes a full third-party
DNS + TLS + download round trip on every first-time visit
(`fonts.googleapis.com` → `fonts.gstatic.com`), means visitors' IPs
never get sent to Google just to render text (see the updated Fonts
section of `privacy.html`), and each page's `<head>` preloads the
primary weight of both so text doesn't wait on font discovery. Only the
"latin" Unicode subset was pulled since that covers everything this
site's copy uses, including smart quotes and em dashes. If the type
ramp ever changes, fetch fresh files the same way: request the Google
Fonts CSS2 API with a modern desktop User-Agent string, pull the
`/* latin */`-labeled `.woff2` URLs, and re-download.

The homepage hero photo and the "Our Story" founder photo both also get
an explicit `<link rel="preload" as="image">` in their page's `<head>`,
since each is that page's LCP (largest contentful paint) element —
telling the browser to fetch it immediately instead of discovering it
only once it parses down to the `<picture>` tag in the body.

## 16. On-site review submissions, explained

`shop.html` has a "Customer Reviews" section (below the product grid and
the wholesale CTA) where visitors can leave their own review, right on
the site — a second, independent channel alongside the Etsy reviews
shown in the trust line up top. The two are kept **deliberately separate**
and never mathematically combined: Etsy's 4.9★/32-reviews number is
real, verified-purchase data; site-submitted reviews are just whoever
filled out a form. Folding the second into the first would misrepresent
both to customers and to Google (the `aggregateRating` JSON-LD on this
page is reserved for genuine Etsy data only — see section 10).

**How it works, end to end:**

1. A visitor fills out the review form (name, email, optional product,
   star rating, review text) and submits it.
2. The form posts to **[Formspree](https://formspree.io)** (free tier:
   50 submissions/month, no credit card required — chosen for the same
   reason as Kit above: a plain `<form action="...">` that needs zero
   backend code, matching this site's whole philosophy). Every
   submission lands as an email in Savanna's inbox. **Nothing is
   published automatically.**
3. Savanna reads the email and decides whether it's real and
   appropriate. If yes, she (or a follow-up Claude session) adds it as
   one plain object to the array in `assets/js/site-reviews-data.js` —
   see that file's header comment for the exact shape. No build step
   needed; it's loaded directly like `products-data.js`.
4. `main.js` renders every entry in that array as a review card (same
   `.quote-card` component as the homepage testimonials) and fills the
   product dropdown from the live catalog. If the array is empty, the
   section shows a plain "no reviews yet" message instead of an empty
   grid.
5. `npm test` validates every entry's shape (rating 1–5, required
   fields, `productId` matches a real product if set) — a typo gets
   caught by CI instead of shipping broken.

**Why moderation is manual, not automatic:** publishing arbitrary
visitor-submitted text straight to a live business page with no human
review is a real spam/abuse/legal risk. This mirrors the same rule
already applied to the automated Etsy sync (`scripts/apply-etsy-
snapshot.js`), which never auto-adds a new product or auto-removes one
either — anything that reaches the live site as "real" content gets a
person's eyes on it first.

**What you (Savanna) still need to do — I can't do this part for you,
since it requires creating an account:**

1. [Sign up for a free Formspree account](https://formspree.io) and
   create a new form.
2. Grab that form's action URL from Formspree's dashboard (looks like
   `https://formspree.io/f/abcd1234`).
3. Enter the Formspree Form ID (just the `abcd1234` part at the end) in the Website Dashboard (`/admin` → Page Wording → Global Site Assets & Configurations → Formspree Review Form ID) or in `assets/data/content.json` under `site.formspreeReviewId`.
4. (And similarly for the contact form: create a contact form in Formspree, grab its ID, and enter it in the dashboard under Formspree Contact Form ID or in `assets/data/content.json` under `site.formspreeContactId`.)
5. Test a real submission once deployed: submit the form, confirm the
   inline "thanks" message appears, and check that the email actually
   lands in your inbox.
6. When you want to publish a review, add it to
   `assets/js/site-reviews-data.js` by hand (or ask for help in a Claude
   session) — see that file's comment for the exact format — then
   refresh the page (or redeploy). No other file changes needed.

The honeypot spam guard and CSP (`form-action` in `scripts/build-
security-headers.js`, which regenerates `_headers`/`vercel.json`/
`netlify.toml`) already allow `formspree.io` — nothing else to configure
there.

## 17. Shop-page search, bundles, and inventory signals

Added together since they all live on `shop.html` and all work with zero
new accounts (unlike gift cards/live chat below):

**Search.** A plain client-side search box (`#shopSearch`, wired in
`buildFilters()` in `main.js`) filters the visible grid by name, blurb,
and category as you type — no search service needed for a 15-product
catalog. Combines with the existing category pills and sort, not
instead of them.

**Quick FAQ.** The site has exactly one FAQ — a `faq` array in
`assets/data/products.json` (edit directly, or via `/admin` — section
20) — and `scripts/build-site-data.js` generates both `contact.html`'s
FAQPage JSON-LD and its visible Q&A prose (`#faq` section) from it, so
there's only ever one place to add, edit, or reorder a question.
`shop.html` doesn't keep its own copy anymore; it just links to
`contact.html#faq` right before checkout (where a shipping/return
question is most likely to come up). `npm test` checks that the
generated JSON-LD and prose actually match the current `faq` array, and
that `shop.html` hasn't quietly grown its own duplicate accordion again.

**Bundles / gift sets.** `assets/data/products.json`'s `bundles` array
combines real existing products at a discount. Bundles never carry
their own `price` field — it's always computed fresh from the current
component-product prices (never a hand-set number, so it can't drift),
both in the browser (`main.js`'s `bundlesHTML()`, for display) and again
server-side in `workers/checkout.js` (for the actual charge, so a
tampered client price is never trusted — see section 8). The three
bundles shipped today are a **starting point I put together, not
a finished merchandising decision** — review the products, the 10%
discount, and the copy before treating them as final. To add a new
bundle: use `/admin` (section 20), or copy one of the existing objects
in that array by hand, pick 2+ real product IDs, set a
`discountPercent`, then run `node scripts/build-site-data.js && npm test`.

**Inventory signals.** `products.json` supports an optional `stock`
field per product (see `admin/config.yml`'s hint text, or
`products-data.js`'s generated header comment) — omit it entirely
(the default for every product today) and nothing changes; set a real
number and the product card shows a honest "Only N left"/"Sold out"
badge and the cart drawer caps quantity at that number
(`data-item-max-quantity`, enforced by `cart.js`). This is
**manually maintained**, not synced from Etsy automatically — I
deliberately didn't wire it to the "X left" numbers Etsy shows, since
that's a separate inventory pool from this site's own checkout and would
be misleading. There's no dashboard-driven automatic option here the way
Snipcart used to offer one — Stripe doesn't have an equivalent built-in
inventory feature, so this manually-set field is the actual long-term
mechanism now, not a stopgap.

**Product Image Lightbox.** Clicking on any non-gift card product image (on the home page or shop page grids) opens a premium glassmorphic lightbox modal (`#imageLightboxModal`). It displays an enlarged view of the product photo and includes interactive next/prev control arrows + gallery navigation indicator dots to cycle through the alternative images in that product's gallery. The modal uses the modern HTML5 `<dialog>` API with keyboard accessibility support (dismisses instantly on hitting `Esc` or clicking the backdrop overlay).

## 18. Digital gift cards, explained

**Custom Stripe-integrated checkout by default.** The Digital Gift Card is fully integrated as a featured item inside the catalog (`products.json`). When a user clicks "Configure Card" on the shop grid, it triggers a state-of-the-art native `<dialog id="giftCardModal">` modal. This modal allows customers to choose preset amounts ($10, $25, $50, $100, $200) or enter a custom amount (from $10 to $500). They can fill out custom purchase fields (Recipient Email, Sender Name, and an optional Message) and add the gift card directly to the on-site cart, alongside any physical products, checking out in one Stripe session.

Fulfillment is automatic, not manual: once payment completes, `netlify/functions/fulfill-gift-card.js` (the checkout webhook, see section 8) generates a redemption code, creates a matching single-use Stripe Promotion Code for it, and emails it to the recipient — Savanna doesn't have to read orders and hand-create anything. The recipient later enters that code at checkout (`workers/checkout.js` sets `allow_promotion_codes: true`) to redeem it.

**Gift cards and sales tax — a known gap, only relevant once tax is on.**
This site redeems a gift card as a Stripe Promotion Code (an `amount_off`
coupon), which means Stripe classifies a redemption as a *discount* and
rates the reduced amount. Tax law generally treats a gift card as a *payment
method* instead: tax the full price, then let the card pay part of the total
including that tax. Combined with the fact that gift cards are correctly
untaxed at purchase (tax code `txcd_10502000`), an order paid entirely with
a gift card currently collects no sales tax at either end — purchase or
redemption. Nobody is over-charged; the shortfall would land on Savanna at
filing time.

Scale matters here before anyone panics: this only bites once
`STRIPE_TAX_ENABLED` is on (see section 8), and only in proportion to how
much of the shop's revenue actually moves through gift cards. Three options,
cheapest first:

1. **Accept and reconcile.** Stripe's tax reports show the gift-card orders;
   account for the difference manually at filing time. Fine at low volume,
   and it costs nothing.
2. **Tax gift cards at purchase** — change `TAX_CODE_GIFT_CARD` in
   `workers/checkout.js` to `txcd_99999999`. This collects roughly the right
   *total* tax, just at the wrong moment and from the buyer rather than the
   recipient. Most states specifically prohibit taxing a gift-card sale, so
   check before choosing this.
3. **Replace coupons with real stored-value balances**, so a redemption is
   applied after tax rather than before. Correct, and much more work — it
   means either a balance-tracking backend or a platform that provides one
   (which is exactly what the Gift Up! note below is about).

**Optional third-party alternative (Gift Up!) — half-built, not usable yet.** The idea: hand off entirely to **[Gift Up!](https://www.giftup.com)** (a purpose-built gift card platform with its own balance tracking, printable cards, and in-person redemption app -- relevant since this business also sells at farmers markets and Pride events, where the built-in Stripe flow has no in-person path at all) if that's ever preferred over the built-in flow.

**Honest status check:** only half of this actually works. `scripts/build-site-data.js` *does* generate a real, functional Gift Up! widget embed when a real `giftUpId` is set (verified in the code). But nothing checks `giftUpId` anywhere in `main.js` or `cart.js` -- the built-in "Configure Card" button and `#giftCardModal` are generated unconditionally (`addToCartHTML()`), with no bypass logic at all. So pasting a real Gift Up! ID today would show **both** gift-card systems live on the same page, not a clean swap. Because of that, the `giftUpId` field is **hidden in the CMS** (`widget: hidden` in `admin/config.yml`) rather than shown-but-unusable -- the key is still declared so the CMS round-trips its value instead of dropping it on save, but Savanna can't set it by accident. Unhide it (`widget: string`) only after the bypass below exists.

### Built-in (Stripe) vs. Gift Up! comparison

This table describes the *intended* end state once the bypass logic
above gets built — not what happens if you paste a Gift Up! ID today
(see the honest status check above: right now, both would run at once).

| Feature | Built-in (Stripe, Default) | Gift Up! Checkout (Not yet wired) |
| :--- | :--- | :--- |
| **How it Works** | Bought as a digital product directly in the main store grid and checkout. | *(Once built)* would bypass the built-in checkout and load a widget from Gift Up!. |
| **Fulfillment** | **Automatic**: `fulfill-gift-card.js` generates the code and emails it the moment payment completes — no manual step. | **Automatic**: Gift Up! automatically generates the code, tracks the balance, and emails a beautiful, ready-to-print digital gift card to the recipient instantly. |
| **Redemption** | Customers enter the emailed Stripe Promotion Code at checkout, same cart as everything else. | Gift Up! codes are scanned/validated through Gift Up!'s own system, or inputted at in-person events via the Gift Up! mobile app. |
| **Cart Integration** | **Unified**: Customers can add a gift card and physical products (like a beard salve) to the same cart and check out once. | **Separated**: Gift cards must be purchased in a separate transaction from physical items. |
| **Balance tracking** | **None** — a code is single-use and fixed-amount (Stripe Coupon with `max_redemptions: 1`), not a running balance that can be partially spent across multiple orders. | Gift Up! tracks a real running balance, redeemable across multiple partial purchases. |
| **Fees** | Stripe's standard per-transaction fee only — no separate gift-card platform fee. | Gift Up!'s own transaction fees (usually around 3.49% on free accounts) *on top* of standard payment processing. |
| **Setup Overhead** | None beyond the checkout Worker + webhook deploy already needed for the rest of the store (section 8). | Requires setting up a Gift Up! account, configuring branding templates, and copying the embed snippet into `shop.html`. |

**If Gift Up! is ever wanted, in this order:**

0. **Steven builds the bypass first** — teach `addToCartHTML()` /
   `giftCardModal` in `main.js` to check `window.YL_CONTENT.site.giftUpId`
   and skip rendering the built-in "Configure Card" button when it's set
   to a real value. Nothing below matters until this exists; skip
   straight to it, this isn't a Savanna step.
1. [Sign up for a free Gift Up! account](https://giftup.app/account/register)
   and set up your branded gift card design.
2. Check [Gift Up!'s current pricing](https://www.giftup.com/pricing)
   for their per-transaction fee before going live.
3. Unhide the field (`admin/config.yml`, `giftUpId`: `widget: hidden` →
   `widget: string`), then grab the real embed snippet from your Gift
   Up! dashboard and enter the account code in `/admin` — copy it
   exactly, don't hand-type it.
4. Check the browser console for any CSP "Refused to ..." errors and
   add whatever domain it names to `scripts/build-security-headers.js`,
   then re-run that script.

## 19. Live chat, explained

**[Tawk.to](https://www.tawk.to)** is wired into all seven pages as an
inert placeholder — genuinely free with no limits on agents, chat
volume, or number of sites, so there's no cost to having the script in
place before an account exists. Look right before `</body>` on any
page for a `Tawk_API` script block with `YOUR_TAWKTO_PROPERTY_ID` and
`YOUR_TAWKTO_WIDGET_ID` placeholders — as written, that script quietly
404s and no chat bubble appears, so nothing is broken by leaving it
alone. The CSP (`scripts/build-security-headers.js`) already
allowlists `embed.tawk.to` (script) and `*.tawk.to` (connect/frame/img)
so turning it on later needs no header changes.

**What you (Savanna) still need to do to turn it on:**

1. [Sign up for a free Tawk.to account](https://www.tawk.to).
2. From Administration → Chat Widget, copy your real embed script —
   it has your real property ID and widget ID baked into the `src` URL.
3. Enter the property ID and widget ID in the Website Dashboard (`/admin` → Page Wording → Global Site Assets & Configurations → Tawk.to Property ID / Widget ID) or in `assets/data/content.json` under `site.tawkToPropertyId` and `site.tawkToWidgetId`.
4. Set your availability hours in the Tawk.to dashboard so it shows
   "offline" (with a leave-a-message form) outside them, rather than
   looking staffed 24/7 when no one's actually watching it.

**Before you turn this on, decide whether you actually want it
staffed** — unlike Stripe/Kit/Formspree, live chat has an ongoing
cost (someone has to answer it, or it just becomes an unanswered
inbox that looks worse than no chat at all). The placeholder ships
inert on purpose so that decision stays yours, not a default.

## 20. Product editor (Sveltia CMS at `/admin`), explained

Everything in sections 7/9/17/18 above that says "edit `products.json`
by hand" now has a friendlier alternative: a real, no-code editing UI at
`/admin` on the deployed site, built on **[Sveltia CMS](https://sveltiacms.app)**
— a form for editing products, bundles, the FAQ, and shop info that
commits straight to the real `assets/data/products.json` file in the
GitHub repo, no text editor or JSON syntax required.

**Why Sveltia over Decap CMS** (the older, much more widely-known
option this space defaults to): Decap is still functional but is now in
low-maintenance mode, and its authentication layer depended on
Netlify Identity, which Netlify deprecated. Sveltia is a newer,
actively-developed rewrite of the same idea — lighter (no React, much
smaller bundle), a modernized editing UI, and it doesn't depend on the
deprecated Netlify Identity service. It reads the exact same
`config.yml` format Decap popularized, so switching later (either
direction) wouldn't require re-learning a schema.

**Honest disclosure — this is pre-1.0 software.** Sveltia's own docs
say so directly: *"Stable Version Not Yet Available... there might
still be breaking changes before the stable 1.0 release."* That's a
real risk, in the same category as this project's other third-party
dependencies (Decap/Netlify Identity's own deprecation is exactly the
kind of thing that can happen to a pre-1.0 tool too) — worth knowing
before treating `/admin` as a permanent, unchanging fixture. If a future
breaking release ever changes `config.yml`'s field syntax, that file
(and this DEVELOPMENT.md section) would need a re-check against Sveltia's
current docs at that time.

**What's already built and wired in (nothing left for me to do here):**

- `admin/index.html` — the exact CDN-loader snippet from Sveltia's own
  docs (no local install, no build step — it loads `sveltia-cms.js`
  straight from unpkg.com).
- `admin/config.yml` — the full field schema, mapped 1:1 to every real
  field in `assets/data/products.json` (shop info, categories, products
  — including variants/ratings/stock/ingredients — bundles, and the
  FAQ). Every field has a plain-English hint where the underlying data
  has a rule worth knowing (e.g. "don't rename a product's `id` once
  it's had real orders," "bundle price is always computed, never
  hand-set"). Nothing was invented — if a field isn't in this file, it
  isn't part of the real catalog schema.
- A path-scoped CSP for `/admin/*` in `_headers`/`vercel.json`/
  `netlify.toml` (separate from, and more permissive than, the main
  site's strict CSP — see the `adminCsp` comment in
  `scripts/build-security-headers.js` for exactly what it allows and
  why).
- The required build step (section 12) in all three deploy configs, so
  a commit from `/admin` automatically regenerates everything derived
  from `products.json` before going live.
- `npm test` validates `config.yml`'s structure (backend type, the file
  path, and that every real `products.json` key has a matching field)
  and checks `products-data.js` stays a fresh, faithful mirror of
  `products.json` — so a schema drift or a missed rebuild gets caught
  the same way every other freshness check on this site does.

**What you (Savanna/Steven) still need to do:**

1. **GitHub Repository Access:** The repository currently lives under Steven's personal GitHub account, and Savanna now has access as a collaborator. If you ever choose to transfer the repository directly to Savanna's own GitHub account in the future (GitHub → repo → Settings → "Transfer ownership"), make sure to update `admin/config.yml`'s `backend.repo` to the new `owner/repo-name` and commit the change (otherwise Sveltia CMS won't be able to save edits, and `npm test` will flag the mismatch).
2. **Set up authentication.** Two real options, in order of how this
   project is already configured:
   - **Using Netlify (the default, zero extra config in `config.yml`).**
     If this site is deployed on Netlify (section 12), Netlify is
     Sveltia's *default* authentication provider for a `github` backend
     the moment you deploy there — Sveltia's own docs confirm: *"It's
     the default authentication method if you don't configure
     authentication explicitly, and you don't need to set up a backend
     server yourself."* The one-time setup happens entirely in
     Netlify's own dashboard, not in `config.yml`: in your Netlify
     site's dashboard, go to **Site configuration → Identity** (or
     search "OAuth" in settings) and enable the **GitHub** OAuth
     provider under **Git Gateway / OAuth**, authorizing it against your
     GitHub account. Once that's done, visiting `/admin` on the live
     site shows a normal "Sign in with GitHub" button — no separate
     GitHub OAuth App needs to be hand-created.
   - **Personal Access Token ("Sign In with Token") — the faster
     option for just Savanna/Steven editing solo**, no OAuth app or
     Netlify dashboard step at all: on GitHub, go to **Settings →
     Developer settings → Personal access tokens → Fine-grained
     tokens**, create one scoped to just this repo with **Contents:
     Read and write** permission, then paste that token into Sveltia's
     "Sign In with Token" option on the `/admin` login screen the first
     time you visit it. Simpler to set up, but the token is a
     credential to protect like a password — don't share it, and revoke
     it from GitHub's settings if it's ever exposed.
3. **Visit `https://<your-real-domain>/admin` and sign in** using
   whichever method you set up. You should see forms for Shop Info,
   Categories, Products, Bundles, and FAQ — editing any of them and
   clicking "Save" commits directly to `assets/data/products.json` in
   the GitHub repo, which triggers a normal deploy (section 12) that
   regenerates everything else automatically.
4. **Test with something low-stakes first** — e.g. edit one product's
   `blurb` by a word, save, confirm the live site updates after the
   deploy finishes, then move on to real catalog changes.

**Local testing, before any of the above exists:** Sveltia CMS also has
a **local backend mode** for testing the editor UI against a local git
clone with zero authentication at all (useful for trying out the field
layout before a real GitHub repo/OAuth setup exists) — see
[Sveltia's "Working with a Local Git Repository" docs](https://sveltiacms.app/en/docs/start)
for the current steps, since this wasn't set up or verified as part of
this project (it needs a real local git repo, which this project didn't
have during development).

**Uploaded images get a leading slash; existing ones don't — this is
harmless.** Sveltia's `public_folder` setting requires a leading `/`
(`/assets/img`), so any new photo uploaded through `/admin` gets stored
as `/assets/img/whatever.jpg` in `products.json`, while all 15 existing
product photos use the old, slash-less `assets/img/whatever.jpg` form.
Both resolve to the exact same file when the browser loads them, and
`npm test`'s image-path check already accounts for this (it matches the
`assets/img/...` substring regardless of a leading slash) — nothing to
fix here, just don't be surprised if you notice the inconsistency
browsing the raw JSON.
