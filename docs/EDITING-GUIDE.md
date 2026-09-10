# Editing Y'allternative Living — A Plain-English Guide for Savanna

Hey Savanna! Welcome to your shop's management guide. You do **not** need to be a coder or web developer to run Y'allternative Living. This guide is written specifically for you to manage products, adjust prices, run multi-buy volume deals, launch sales, update market schedules, and share stories easily.

Nothing in this dashboard touches customer credit card numbers or sensitive payment info — Stripe securely handles checkout and transactions behind the scenes (see `docs/DEVELOPMENT.md` section 8, or `docs/SETUP-GUIDE.md` for account connections).

---

## 1. Your Dashboard Overview: The Editor at `/admin`

Whenever you want to make changes to the live site, open **yourdomain.com/admin** in any web browser and log in (see [How to Log In](#2-how-to-log-in) below).

Your dashboard is organized into 7 focused sections in the left sidebar. The **Journal** sits under the **Collections** heading at the top and shows your list of posts; every other section sits under **Sections** below it and opens straight into its editor when you click it. The numbers match the walkthroughs in this guide, not the order on screen:

1. **Shop & Products** — Your daily workspace:
   - **Products (Top Priority)**: Manage your 19 catalog items, edit prices, set size/scent variants, upload photos, add ingredients, and update stock levels.
   - **Multi-buy deals**: Set up mix-and-match multi-buy category tiers (like *Any 2+ 2 oz Salves for $15 each*).
   - **Category sales**: Put whole categories on sale at once with percentage discounts (e.g. *15% off Body & Skin*).
   - **Gift bundles**: Create curated gift sets (*Discovery Flight*, *Everyday Armor Kit*) with auto-calculated bundle pricing.
   - **FAQ**: Update questions and answers on shipping, returns, paying, gift cards, promo codes, ingredients, shelf life, and custom orders.
   - **Shop details & shipping** (first thing in the form): Etsy sync counters, free shipping threshold, cart reward tiers and Build-Your-Own Box settings — then the products, deals, bundles, FAQ and category filters.
2. **Markets & Pop-Ups** — Add upcoming pop-up markets, craft fairs, and Pride events. Upcoming dates display chronologically, and past appearances automatically archive themselves under "Where We've Been."
3. **Customer Reviews** — Publish customer reviews and choose which glowing testimonials feature on the homepage carousel.
4. **Journal** — Each post is its own entry with a **New Post** button. Write kitchen updates, herbal deep-dives, and community announcements with a visual formatting toolbar.
5. **Social Media Feed** — Feature your favorite Instagram and TikTok posts directly on the homepage.
6. **Site Settings** — Update homepage hero copy, About page story, bio photos, logos, social share images, and toggle site features on or off.
7. **Quiz** — The questions, answer options, and product recommendations behind the Apothecary Recommendation Quiz.

> **💡 The "Hit Save and Done" Rule:** When you click **Save** in `/admin`, the site automatically rebuilds, optimizes your photos, updates search engines, and publishes your changes live to the web within 2 to 3 minutes. You never need to run commands or touch server settings.

---

## 2. How to Log In

Your login does **not** rely on Netlify's deprecated Identity service. You can log in using either of these two straightforward methods:

### Option A: Sign In with Personal Access Token (Works Right Now!)
1. Generate a GitHub Personal Access Token (classic) with `repo` permissions (takes 60 seconds — full click-by-click walkthrough in `docs/SETUP-GUIDE.md` Step 9).
2. Go to `yourdomain.com/admin`.
3. Paste your token into the login box and click **Sign In**.
4. You're in! Your browser will remember your session.

### Option B: Sign In with GitHub Button (Permanent One-Click Login)
Once Steven completes the one-time OAuth app setup (`docs/DEVELOPMENT.md` Section 20, Option B), `/admin` displays a friendly **Sign in with GitHub** button. Click it, authorize your account, and you're immediately inside your dashboard.

---

## 3. Step-by-Step Walkthroughs

---

### A note on the other five languages

Your shop shows up in Spanish, German, French, Japanese and Chinese as well as
English, and you do not have to do anything about it. When you save a change to
a product name, blurb, description or any other wording in `/admin`, a helper
runs on its own and writes the five translations within about ten minutes.
Until it finishes, that one piece of wording simply shows in English to a
customer who has picked another language — nothing looks broken and nothing
needs fixing. If a sentence ever cannot be translated safely (for example, it
would turn a nice description into a health claim, which the law is strict
about for skincare), it is left in English on purpose and Steven gets a note
about it. You never need to translate anything by hand.

---

### A note on wording, and the check that reads it

After you save, a check reads only the wording you just changed — not the whole
shop, and never anything you left alone. If something in it reads like a health
promise ("brings the itch right down", "helps with eczema") or a bug-repellent
promise ("keeps the mosquitoes off"), you get an email with your own sentence
quoted, one plain line about why that particular wording is the kind the FDA or
the EPA cares about, and one or two ways to say the same thing that sound like
you. That is all it does. **It never changes your words**, it cannot stop your
edit going live, and there is nothing to approve or dismiss — if the note is
not useful, ignore it.

Two things it will not pester you about. The four wordings from the September
review that are still your decision — "Y'all Heal Now", "Sleep Salve",
"Backroad Recovery" and the bug spray — are listed at the bottom of the note as
things you already know about, never as something new. And a save with nothing
worth flagging sends you nothing at all, so an email from it means there is
genuinely something to look at.

---

### A note on search words

You do not have to guess what a customer will type. Fill in **Search keywords**
on a product with whatever comes to mind and leave the rest alone — after you
save, the site adds more search words for you, on its own, within a few minutes.
It adds the plain-language ones people actually use ("that bug stuff"), the
occasions ("stocking stuffer", "post hike"), the ingredient names, and the
common misspellings.

**Your own keywords always win.** They come first, nothing you wrote is ever
changed or removed, and if the site had already added a word you later type
yourself, yours is the one that stays. None of the added words are written into
your product — they exist only so the search box can find the right thing.

Symptoms and conditions still stay out of Search keywords, exactly as the hint
under the field says: those go under **Site Settings → Search settings → Extra
search words**, which only translate what a customer typed and are never shown
anywhere. The site follows the same rule when it adds words for you, and Steven
gets a list of anything it decided not to add.

### When somebody searches a medical word

Some customers will type a condition or a medicine word into the search box —
"psoriasis", "cure", "pain", "wound salve" — and some will type a bug word,
"mosquito bites" or "ticks". You do not have to write anything for that, and you
should not try to. The site already recognises those words. It shows a short
note above the results that says we make comfort products, not medicines, and
that nothing here is meant to diagnose, treat, cure or prevent anything, and it
points the customer at the right shelf — dry, rough skin, or wind-down, or after
a long day, or porch nights and trail days — by name, not by condition and not
by bug. Their ordinary words still work while it does: "wound salve" still
brings back the salves and "bug spray" still brings back the bug spray, because
only the medical or bug word is set aside.

The bug words are on that list for a different law than the rest, which is why
they are there even though nobody would call a mosquito a disease: naming the
pest is what turns a spray into a regulated pesticide, so the site treats
"mosquito", "tick" and "bites" the same way it treats "eczema". That is also
why the bug spray's own description is on Steven's list to look at.

**That list of words is not something to add to.** It is not a menu, it is not
in your dashboard, and it must never turn into a row of buttons or a "popular
searches" list with conditions on it. Recognising the word somebody typed is
fine; offering a list of conditions to click is the thing that would get the
shop in trouble. If you think a word is missing, tell Steven rather than putting
it anywhere yourself.

---

### Walkthrough 1: Products, Pricing, Variants & Stock Levels

#### A. Changing a Product's Base Price
1. In `/admin`, click **Shop & Products**.
2. Under **Products**, click the item you want to edit (e.g., *Y'all Heal Now Miracle Frankincense Salve*).
3. Find the **Price (USD)** field and type the new price (e.g. `20`).
4. Click **Save** in the top bar. All bundle discounts, cart calculations, and SEO tags update automatically!

#### B. Adding Sizes, Scents, or Style Variants (with `priceDelta`)
For products available in different sizes (e.g. 1 oz vs 2 oz salve, 4 oz vs 8 oz soak) or scent blends:
1. Open the product and expand the **Variants** section.
2. Set **Variant type** to `Size`, `Scent`, `Blend`, or `Option`.
3. Under **Options**:
   - **Base Option (Required Rule)**: Exactly **one** option must have a **Price difference** of `0`. This represents your base price entered above (e.g., Option name `2 oz`, Price difference `0`).
   - **Additional Options (+ / - Deltas)**: Enter how much more or less the other sizes cost compared to the base price:
     - For a smaller size that costs less (e.g. 1 oz Salve for $14 when base is $20): enter `-6`.
     - For a larger size that costs more (e.g. 8 oz Soak for $24.00 when 4 oz base is $14.00): enter `10.00`.
   - **⚠️ Character Trap**: Never use the characters `[`, `]`, or `|` inside option names (e.g. write `2 oz Glass Jar`, **not** `2 oz [Jar]`), as those symbols are used internally by the shopping cart.

#### C. The 5 Inventory & Availability States
Manage stock with complete transparency and urgency without artificial hype.

**The count runs itself.** **Stock count** is where you *set* a number; the shop then counts it down on its own as orders are paid (and puts units back when a checkout is abandoned or an order is fully refunded). A product you set to `10` that sells 3 shows "Only 7 left" — and, at 0, "Sold Out" — with no edit from you and no publish. Two things follow from that:

- **Saving a new Stock count resets the live count to that number.** Only retype it when you have actually recounted the shelf; re-saving the product with the *same* number leaves the live count alone.
- **Site settings → Shop → Show live stock counts** (on by default) is the switch for the shop showing the live number. Off, product cards show the count as it was at the last publish; checkout still uses the live one so it can never sell what has already gone.

The "Stock count" field is the only place a count is entered — there is nothing to update elsewhere.

**Your Square register counts the same number.** Once Square is connected (SETUP-GUIDE Step 10), every sale rung up at a market — cash, card, tap, or a freebie rung as a 100% discount — comes off the Stock count within seconds, and the live count is sent back to Square so the register shows what's left. The match is the item's **SKU in Square**: set it to the product's ID (`lavender-soak`), or the ID plus a size (`lavender-soak/24-oz` — every size shares one count), or list your existing SKUs under the product's **Square SKUs** field here. If a register sale can't be matched you get an email naming the item; fix its SKU, then adjust the Stock count for the ones already sold. **Site settings → Shop → Sync stock with Square** pauses it. Correct counts here, never in Square — the site is the boss of the number and overwrites Square's within the hour.


| Desired Storefront Experience | What Customers See | How to Configure in `/admin` |
|---|---|---|
| **1. Made-to-Order / Unlimited** | Standard active "Add to Cart" button | Leave **Stock count** blank (empty) and ensure **In stock** is checked. |
| **2. Low-Stock Urgency Badge** | "Only 3 left! — order soon" warning badge on card | Enter a number from `1` to `5` in **Stock count** — or set any number and let sales bring it down to 5. |
| **3. Entire Product Sold Out** | "Sold Out" badge; buy button replaced with "Email Me When Restocked" signup | Enter `0` in **Stock count** OR uncheck **In stock** — or let the last unit sell; the live count reaching 0 does the same. |
| **4. Single Variant Sold Out** | Size dropdown displays option greyed out (e.g. "1 oz — sold out"; unclickable) | Expand **Variants → Options**, find that option, and switch **Sold out?** to `ON`. *Never delete the option, so customers know you make it and it will return!* |
| **5. Coming Soon / Launch Signup** | "Coming Soon" badge; buy button replaced with "Email Me When It Launches" signup | Switch **Coming soon** to `ON` (checked). |

---

### Walkthrough 2: Multi-Buy Volume Deals (`volumePricing`)

Multi-buy deals encourage customers to mix and match multiple items within a category to unlock volume savings (e.g., *Buy 2 or more 2 oz Salves for $15 each*, regularly $20 each).

#### How Multi-Buy Works in the Cart:
- If a customer adds 1x *Frankincense Salve (2 oz)* ($20), it rings up at $20.
- As soon as they add 1x *Sleep Salve (2 oz)* ($20), the cart detects 2 qualifying items in `salves`, drops BOTH to $15 each, and totals $30 with a cheerful savings announcement!
- If they add a 3rd qualifying salve, it also receives the $15 rate ($45 total).

#### How to Create or Adjust a Volume Deal:
1. In `/admin`, open **Shop & Products**.
2. Click to expand **Multi-buy deals** right beneath Products.
3. Click an existing rule (e.g., `2 oz Salve Multi-Buy`) or click **Add Deal**:
   - **Deal ID**: A clean lowercase code with dashes (e.g. `salves-2oz`, `soaks-multi`).
   - **Deal name**: A descriptive title for your reference (e.g. `2 oz Salve Multi-Buy`).
   - **Category**: Select the category from the dropdown (e.g. `Salves & Balms`).
   - **Qualifying variant** *(optional)*:
     - Type a specific variant label (e.g. `2 oz`) if the deal only applies to that specific size. (1 oz jars or balves in other sizes remain unaffected).
     - Leave blank if *all* products and sizes in that category qualify.
   - **Minimum quantity**: The quantity threshold needed to activate the discount (e.g. `2`).
   - **Discounted unit price ($)**: The discounted unit price (e.g. `15`).
   - **Deal badge wording**: The badge copy shown on product cards and cart summaries (e.g. `2+ for $15 each`).
   - **Deal enabled**: Toggle `ON` to run the deal, or toggle `OFF` to pause the promotion anytime without deleting your setup.
4. Click **Save**.

---

### Walkthrough 3: Category Sales & Single-Item Sales

#### A. Running a Storewide Category Sale (`sales`)
Put an entire category on sale at once (e.g. 15% off all *Body & Skin*):
1. In `/admin` → **Shop & Products**, open **Category sales**.
2. Click **Add Sale**.
3. **Which category is on sale**: Pick the category from the dropdown (e.g. `Body & Skin`).
4. **Percent off**: Type the percentage discount (e.g. `15` for 15% off).
5. **Sale name customers see**: Enter the badge headline (e.g. `Spring Body Care Sale`).
6. Click **Save**. Every item in that category automatically shows a sale badge, calculated discount price, and crossed-out regular price.

#### B. Single-Product Sale
Put just one item on flash sale:
1. In **Products**, open the item.
2. Expand the **Sale** box.
3. Enter the **Sale price ($)** (e.g. `15.00`) and the **Sale name customers see** (e.g. `Flash Sale`).
4. In **Original price**, enter the regular price (e.g. `20`) so the crossed-out comparison price appears.
5. Click **Save**.

---

### Walkthrough 4: Curated Gift Sets & Bundles (`bundles`)

Bundles are pre-curated collections (like the *Grit & Grace Starter Set* or *Discovery Flight*).

- **Dynamic Math (No Price to Type!)**: Bundle prices calculate automatically from the live prices of whatever items are inside, minus your discount percentage. If you update a salve's price, every bundle containing that salve recalculates its price automatically.
- **How to Create or Edit a Bundle**:
  1. In `/admin` → **Shop & Products**, open **Gift bundles**.
  2. Click **Add Bundle** or click an existing bundle to edit.
  3. **Bundle name**: Give your gift set a warm name (e.g. `Backwoods Burnout Recovery Kit`).
  4. **Products in this bundle**: Select 2 or more products by typing and clicking their real product names from the searchable dropdown list.
  5. **Discount percent**: Enter the discount percentage (e.g. `10` for 10% off, or `15` for 15% off).
  6. **Bundle description**: Write a vivid description of who it's for and what's inside.
  7. Click **Save**.

---

### Walkthrough 5: Shop Settings, Technical Filters & Navigation

At the top of **Shop & Products**:

| Setting | Where to Find It | What It Controls |
|---|---|---|
| **Free shipping threshold** | `Shop details & shipping` | Set the dollar amount where shipping becomes free (default is `$40`). Set to `0` to disable free shipping. |
| **Etsy Live Counters** | `Shop details & shipping` | Update your live Etsy star rating (e.g. `4.9`), review count (e.g. `32`), and total sales (e.g. `105`) to keep your site trust badges synced. |
| **Build-Your-Own Box** | `Shop details & shipping` | Set minimum items (e.g. `3`), maximum items (e.g. `5`), discount percent (e.g. `10%`), and select eligible categories for custom boxes. |
| **Product categories** | `Product categories` | Add or rename category buttons across the top of `/shop.html`. |
| **Shop FAQ** | `FAQ` | Add or edit question & answer pairs shown on the FAQ page (the shop page links to it). An answer can carry a link, written like `[events page](events.html)`. New or changed answers are translated into the other eight languages automatically after they publish. |

#### The phone filter bar

On a phone the shop no longer shows every category and concern button above
the products. Customers get one row -- the search box, a **Filter** button
(with a little count of how many filters are on) and a **Sort** button -- and
tapping either slides up a panel holding the same category, concern, scent
and sort choices. Filters they pick show as small removable chips above the
products, with a **Clear all** next to them. Tablets and computers still show
the full row of buttons exactly as before.

The categories, concerns and scents in that panel are the ones you already
manage (**Product categories**, **Shop concerns**, each product's **Scent**);
nothing about editing them changes. The words on the row and the panel are
yours too: **Site Settings → Shop page → Phone filter bar wording**.

| Field | What it is | Standard wording |
|---|---|---|
| **Filter button** | Opens the panel. The count of active filters is added for you. | `Filter` |
| **Sort button** | Opens the panel at the sort choices. | `Sort` |
| **Panel heading** | The title at the top of the slide-up panel. | `Filter & sort` |
| **Category group heading** / **Concern group heading** | The small headings above each group of buttons inside the panel. | `Category` / `Concern` |
| **Apply button** | Closes the panel and shows the results. | `Apply` |
| **Clear-all button** | Resets every filter and the search box. Shown in the panel and next to the chips. | `Clear all` |
| **Active filters label** / **Remove-chip word** | Read aloud by screen readers only (the chip row's name, and the word before a chip's name, e.g. "Remove Salves & Balms"). Never shown on screen. | `Active filters` / `Remove` |

Leave any field blank to keep the standard wording. Like the rest of the
site's copy, new wording is picked up by the translation run described in
"A note on the other five languages" above -- write it in English only.

---

### Walkthrough 5a: Promo codes (discount codes)

Promo codes are **not** created in the dashboard -- they live in Stripe, which
is what actually takes the money off. The click-by-click for making one is in
`docs/SETUP-GUIDE.md`, Step 3, part E. What the dashboard controls is how the
shop *presents* them:

| Setting | Where to Find It | What It Controls |
|---|---|---|
| **Accept promo codes in the cart** | `Site Settings` -> `⚙️ Site Settings` -> `Shop · Accept promo codes in the cart` | ON (the default) adds a "Have a code?" box to the cart, beside the gift card one. The shop checks the code with Stripe the moment it is typed and shows the discount and the new total *before* checkout, so nobody finds out on the payment page. OFF hides the box; Stripe's own code field on the payment page still works. Codes never apply to a gift card purchase, and can't be combined with a gift card. |
| **Promo code prompt** | same screen -> `Shop · Promo code prompt` | The words on that box ("Have a code?"). Keep it short -- it shares a row with the gift card prompt. |
| **Promo code + gift card notice** | same screen -> `Shop · Promo code + gift card notice` | The sentence shown when someone has a gift card applied and enters a promo code too. Stripe allows **one** discount per order, so the code waits (it is kept, greyed out) until the gift card is removed. |

Things worth knowing:

- A code is checked twice: once in the cart (so the total is right) and again
  at checkout (so the total Stripe charges is the one the cart showed). A code
  that stops working in between -- expired, used up, or the cart dropped under
  its minimum -- is taken off with a plain sentence, never silently charged at
  full price.
- The cart re-checks a code on its own when the cart changes, so a
  "$50 minimum" code that was applied at $60 comes off (and says why) if the
  customer removes something.
- What customers see when a code does not work is written in the site, not by
  Stripe: "That code isn't valid", "This code needs a subtotal of at least
  $50", "That code has expired or has already been used". No Stripe wording,
  and never the code's internal ids.
- Coupons in Stripe that are limited to specific Stripe *products* do not work
  here (the shop builds its prices at checkout time rather than from Stripe's
  product catalog) -- make coupons that apply to the whole order.
- Free shipping is not something a code can grant: Stripe discounts the goods,
  never the postage. Use the free-shipping threshold for that.

### Walkthrough 5b: Marking an order shipped

This is the one thing in the shop that is done in **Stripe**, not in the CMS —
and it is what sends your customer their tracking number.

1. Open the payment in Stripe (**Payments** → click the order).
2. Scroll to **Metadata** and click **Edit metadata**.
3. Add these, then **Save**:

| Key | Value |
|---|---|
| `fulfillment_status` | `shipped` |
| `tracking_url` | the carrier's tracking link (starts with `https://`) |
| `shipped_at` | the date, however you like to write it |

Saving that does three things. Their order-status page starts saying **Shipped**
straight away. Then, **within the hour** — the site checks Stripe for newly
shipped orders once an hour, because Stripe does not announce this kind of edit
on its own — the customer gets a "your order just left Landrum" email with the
tracking button in it, and the "how to use it" email is re-timed to arrive a few
days after the box does instead of a few days after they paid. So if you mark
something shipped at 2:05 and the customer has nothing by 2:10, that is normal;
by 3:10 it should be there.

**Put the status and the tracking link in the same save.** The email only sends
once per order — on purpose, so fixing a typo later cannot mail somebody twice —
so a tracking link added afterwards will show on their order page but will not
have been in the email they already got.

If you never mark an order shipped, nothing breaks: the customer just does not
get that email, and the "how to use it" one goes out on an assumed 3-day
shipping window instead of a real one.

#### The two customer-email settings

Both live in **Site Settings → ⚙️ Site Settings**, near the "Emails to me"
switches:

- **Send a "how to use it" note after delivery** — off stops it completely,
  including the ones already waiting in the queue. Products with the
  **Usage & care** section left blank are skipped either way.
- **Days after shipping to send it** — counted from the day you mark the order
  shipped, not from when it was paid for. Four days is the default, which lands
  it just after most parcels do.

The tracking email itself has no switch: it is a fact about somebody's parcel,
so it always sends.

---

### Walkthrough 5c: The "Your Orders" page

`/orders.html` lets a customer who has bought here before see every order
placed with their email — what they bought, the total, whether it has shipped,
the tracking link — and put the same things back in their cart with one
button. **There are no accounts and no passwords.** They type the email they
ordered with, the shop emails them a link, and the link opens their orders.
The link works once and dies after 24 hours; if they want to look again they
ask for a fresh one.

Nothing to set up: it uses the same Resend key that sends gift cards and the
same signing secret the points links use.

**What you can change (Site Settings → Your Orders page):** the small line
above the headline, the headline, the intro paragraph, the email box label
and the note under it, the button text, and the confirmation shown after the
button is pressed. One rule for the confirmation: keep it neutral — "if we
have orders for that address, a link is on its way". The page shows exactly
the same words whether or not that email has ever ordered, so nobody can type
someone else's address into it to find out if they shop here.

**One switch (Site Settings → ⚙️ Site Settings → Shop · Show the Your Orders
page):** off hides the links to it in the footer, on the thank-you page and on
the order-status page, and the page itself shows an "email us" note instead of
the form. Orders keep being recorded either way, so switching it back on shows
everything.

**Points:** if **Show Customer Rewards Points** is on, the page also shows the
customer's Alt-Points balance and how far they are from the next reward code.

---

### Walkthrough 6: Pop-Ups, Reviews, Blog, Social Feed & Site Settings

#### A. Pop-Up Markets & Pride Events (Markets & Pop-Ups)
1. Click **Markets & Pop-Ups** in the sidebar.
2. Click **Add Event** under **Upcoming pop-ups**.
3. Fill in the event title, start date (and end date if multi-day), friendly date label (e.g. `Saturday, Oct 12 · 9am–2pm`), location, and event link.
4. **⚠️ Crucial Sales Tax Note**: Always enter the **5-digit ZIP code** for any market where customers can select "Local Market Pickup" during online checkout. Sales tax in South Carolina is based on the exact pickup location, so the ZIP code ensures accurate tax calculation.

#### B. Publishing Customer Reviews (Customer Reviews)
1. Click **Customer Reviews** in the sidebar.
2. Click **Add Review**.
3. Enter the customer's name, star rating (1–5), review text, and select the product from the dropdown.
4. Check **Feature on homepage?** to showcase their review in the homepage testimonial carousel.

#### C. Journal / Blog (Journal)
1. Click **Journal** in the sidebar to see the list of posts. Click a post to edit it, or **New Post** (top right) to write one.
2. (The page title and intro line shown above the post list live under **Site Settings → Journal page**, along with the three small labels every post page carries: the **← Back to Journal** link and the **Newer post** / **Older post** links at the bottom.)
3. Enter the title, date, and a **Short teaser** (1–2 sentences for card previews; it is also the description search engines and social cards show for the post).
4. Write your story in the main content box using the formatting toolbar (bold, italics, headings, bullet lists).
5. Estimated reading time calculates automatically when published!
6. **Every post gets its own web page**, built from the title the **first** time you save (so "Why Magnesium & Arnica?" becomes `yallternativeliving.com/journal/why-magnesium-arnica.html`) -- that is the address the Journal list, the RSS feed, search engines and social cards all use, so it is the one to share. It never changes afterwards, even if you retitle the post, so a link you have already shared keeps working. You never type the address yourself. The featured product you pick shows as a card on the post page with a link to that product's own page and a one-click **Add to Cart**.

#### D. Social Media Feed (Social Media Feed)
1. Click **Social Media Feed**.
2. Add new Instagram or TikTok post snapshots with photos, captions, and tagged products.

#### E. Site Settings (Site Settings)
1. Click **Site Settings**.
2. Update homepage headlines, About page story text, or swap non-product photos (homepage hero banner, About bio photo, site logos).
3. Under **Switches & branding** (the first thing in the Site Settings section), you can toggle features on or off anytime with simple checkboxes -- including **Show live chat (Tawk.to)**, which hides the chat bubble everywhere without losing your Tawk.to IDs:
   - Restock Email Alerts (a request now really is emailed to the shop -- it
     used to be accepted and discarded)
   - Apothecary Recommendation Quiz
   - Local Market Pickup
   - Live Event Countdown Ticker
   - Scent Filter
   - Apothecary Journal Blog (while it is off, the nav link, the page, the post pages, the
     RSS feed and the search index all stay empty until you switch it on)
   - UGC Social Feed
4. Also under **Site Settings**, in the **Emails to me** group, is
   **Where shop alerts go**. The checkout system watches itself: if an order
   doesn't register after a payment goes through, if sales tax could not be switched on for an order,
   if an hourly job died, or if an email to a customer could not be sent after
   several tries, it emails a short plain-English alert saying what broke, the
   order or session it concerns, and what to check. Type the address those
   alerts should go to, or leave it blank and they go to the shop's order
   mailbox. You will never get more than one email about the same problem in
   any six-hour stretch, so a bad night is one message, not fifty. If an alert
   arrives and you are not sure what it means, forward it to Steven.

   **Two switches in that panel do less than their labels suggest.**

   - **Show Customer Rewards Points** (`enableLoyaltyPoints`, and the four
     related "Rewards Currency" fields). Points are credited server-side from
     every paid order and paid out automatically as a discount code at the
     threshold, whatever this switch says; the earn message, the cart counter
     and the redeem button stay removed. What the switch DOES control is
     whether the customer's balance is shown on the **Your Orders** page
     (Walkthrough 5c) -- off hides it there.
   - **Show Order Lookup Tool** (`enableOrderStatusLookup`). `/order-status`
     now does a real lookup against Stripe (reference + email); off hides the
     lookup form and shows the contact route instead.

---

## 4. Photos & Media

- **Uploading Photos via `/admin`:** Whenever you upload a product photo or gallery image in `/admin`, the build system automatically converts it into modern, blazing-fast responsive formats (AVIF and WebP) during deploy.
- **Local / Direct Image Addition:** If you or Steven add images directly to `assets/img/`, name them cleanly (e.g. `sleep-salve.jpg`, `sleep-salve-alt1.jpg`), then run `npm run optimize-images`.
- **Replacing Placeholder Photos:** Five products currently have temporary placeholder badges (`Y'all Means All Sugar Scrub`, `Y'all Means All Rainbow Whipped Body Butter`, `Appalachian Rain Clearing Mist`, `Moonlit Meadow Bath Tea`, and `Porch Sweep Clearing Mist`). To launch them:
  1. Upload the real product photo in `/admin`.
  2. Switch **Coming soon** to `OFF`.
  3. Hit **Save**. The product is immediately live and buyable!

---

## 5. The "Edit the File" Way (For Developers & Terminal Work)

If Steven or a developer wants to update the catalog directly in code:
1. Edit `assets/data/products.json`.
2. Compile derived files and HTML markers:
   ```bash
   export PATH="/opt/homebrew/bin:$PATH"; npm run build-data
   ```
3. Run the automated QA suite to ensure all 364+ checks pass:
   ```bash
   export PATH="/opt/homebrew/bin:$PATH"; npm test
   ```

---

## 6. What Requires Developer Help

The dashboard gives you control over your entire catalog, promotions, pricing, markets, reviews, and page wording. Only a few structural elements still require a quick edit from Steven:
- Modifying legal policy text on `privacy.html`, `terms.html`, or `policies.html`.
- Modifying global CSS layouts or adding entirely new page templates.

---

## 7. Quick Reference Cheat Sheet

| What You Want to Do | Where in `/admin` | Result |
|---|---|---|
| **Change product price** | `1. Products` → Click product → `Price` | Instant price update on card, modal & checkout |
| **Add size/scent option** | `1. Products` → `Variants` → Add option with `priceDelta` | Dropdown picker appears on product page |
| **Mark one size sold out** | `1. Products` → `Variants` → Switch `Sold out?` to ON | Size shows as greyed-out "(Sold out)" in picker |
| **Mark whole item sold out** | `1. Products` → Set `Stock count` to 0 or uncheck `In stock` | Shows "Sold Out" badge & Restock Email signup |
| **Show low stock urgency** | `1. Products` → Set `Stock count` to 1, 2, 3, 4, or 5 | Shows "Only X left! — order soon" badge |
| **Restock a sold-out item** | `1. Products` → Set `Stock count` to the new number | The live count resets to it; badge and buy button follow at once |
| **Hide live counts on the shop** | `Site settings` → `Shop` → untick `Show live stock counts` | Cards show the last-published count; checkout still uses the live one |
| **Match a Square register item to a product** | Square Dashboard → the item → `SKU` = the product's ID (or list it under `1. Products` → `Square SKUs`) | Register sales count the Stock count down; the register shows the site's live count |
| **Pause the Square sync** | `Site settings` → `Shop` → untick `Sync stock with Square` | Register sales stop counting down and nothing is sent to Square until it's back on |
| **Set up 2+ Multi-Buy Deal** | `1. Products` → `Multi-buy deals` | Customers mixing qualifying items get auto unit discounts |
| **Run category % off sale** | `1. Products` → `Category sales` | Sale banner, strikethrough prices & cart discounts |
| **Create gift bundle** | `1. Products` → `Bundles` → Pick products & discount % | Pre-made set with auto-calculated price |
| **Change free shipping minimum** | `1. Products` → `Shop details & shipping` → `Free shipping threshold` | Progress bar & checkout threshold update |
| **Add market / pop-up date** | `2. Markets` → Add event (include ZIP code!) | Shows on event list & calculates pickup tax |
| **Feature customer review** | `Customer Reviews` → Check "Feature on homepage?" | Displays in homepage testimonials carousel |
| **Publish blog post** | `4. Apothecary Journal` → Add post with visual editor | Live blog article with calculated read time |
| **Update hero / About story** | `Site Settings` | Text and photos update across homepage & About |
| **Toggle site features** | `Site Settings` → `⚙️ Site Settings` | Turn quiz, rewards, ticker, or pickup on/off |
| **Make a promo code** | Stripe → `Products` → `Coupons` → `New` → then `Promotion codes` → `New` (see SETUP-GUIDE Step 3E) | Customers can type it in the cart's "Have a code?" box and see the discount before checkout |
| **Turn the cart's code box off** | `Site Settings` → `⚙️ Site Settings` → untick `Shop · Accept promo codes in the cart` | The box disappears; Stripe's own code field at checkout still works |
| **Edit the "how to use it" email** | `1. Products` → Click product → `Usage & care` | Same copy the product page shows and the after-delivery email sends |
| **Turn that email off, or move it** | `Site Settings` → `⚙️ Site Settings` → `Emails to customers · …` | Switch it off entirely, or change how many days after shipping it goes |
| **Tell a customer it shipped** | Stripe → the payment → `Metadata` | Sends the tracking email and updates their order status page and their Your Orders page (see below) |
| **Change the wording on the Your Orders page** | `Site Settings` → `Your Orders page` | Headline, intro, labels, button, confirmation (Walkthrough 5c) |
| **Hide the Your Orders page** | `Site Settings` → `⚙️ Site Settings` → `Shop · Show the Your Orders page` | Off hides its links and shows an "email us" note on the page |
| **Choose where "something broke" alerts go** | `Site Settings` → `⚙️ Site Settings` → `Emails to me · Where shop alerts go` | Failures behind the scenes are emailed there (blank = the order mailbox), at most one per problem every six hours |

---

*Made with love in Landrum, South Carolina. Y'all Means All.*
