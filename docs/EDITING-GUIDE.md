# Editing Y'allternative Living — A Plain-English Guide for Savanna

Hey Savanna! Welcome to your shop's management guide. You do **not** need to be a coder or web developer to run Y'allternative Living. This guide is written specifically for you to manage products, adjust prices, run multi-buy volume deals, launch sales, update market schedules, and share stories easily.

Nothing in this dashboard touches customer credit card numbers or sensitive payment info — Stripe securely handles checkout and transactions behind the scenes (see `docs/DEVELOPMENT.md` section 8, or `docs/SETUP-GUIDE.md` for account connections).

---

## 1. Your Dashboard Overview: The Editor at `/admin`

Whenever you want to make changes to the live site, open **yourdomain.com/admin** in any web browser and log in (see [How to Log In](#2-how-to-log-in) below).

Your dashboard is organized into 7 focused sections in the left sidebar. The **Journal** sits under the **Collections** heading at the top and shows your list of posts; every other section sits under **Sections** below it and opens straight into its editor when you click it. The numbers match the walkthroughs in this guide, not the order on screen:

1. **Shop & Products** — Your daily workspace:
   - **Products (Top Priority)**: Manage your 19 catalog items, edit prices, set size/scent variants, upload photos, add ingredients, and update stock levels.
   - **Multi-buy deals**: Set up mix-and-match multi-buy category tiers (like *Any 2+ 2oz Salves for $15 each*).
   - **Category sales**: Put whole categories on sale at once with percentage discounts (e.g. *15% off Body & Skin*).
   - **Gift bundles**: Create curated gift sets (*Discovery Flight*, *Everyday Armor Kit*) with auto-calculated bundle pricing.
   - **FAQ**: Update questions and answers on shipping, returns, shelf life, and custom orders.
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
shopper who has picked another language — nothing looks broken and nothing
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

---

### A note on search words

You do not have to guess what a shopper will type. Fill in **Search keywords**
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
search words**, which only translate what a shopper typed and are never shown
anywhere. The site follows the same rule when it adds words for you, and Steven
gets a list of anything it decided not to add.

---

### Walkthrough 1: Products, Pricing, Variants & Stock Levels

#### A. Changing a Product's Base Price
1. In `/admin`, click **Shop & Products**.
2. Under **Products**, click the item you want to edit (e.g., *Y'all Heal Now Miracle Frankincense Salve*).
3. Find the **Price (USD)** field and type the new price (e.g. `20`).
4. Click **Save** in the top bar. All bundle discounts, cart calculations, and SEO tags update automatically!

#### B. Adding Sizes, Scents, or Style Variants (with `priceDelta`)
For products available in different sizes (e.g. 1oz vs 2oz salve, 4oz vs 8oz soak) or scent blends:
1. Open the product and expand the **Variants** section.
2. Set **Variant type** to `Size`, `Scent`, `Blend`, or `Option`.
3. Under **Options**:
   - **Base Option (Required Rule)**: Exactly **one** option must have a **Price difference** of `0`. This represents your base price entered above (e.g., Option name `2oz`, Price difference `0`).
   - **Additional Options (+ / - Deltas)**: Enter how much more or less the other sizes cost compared to the base price:
     - For a smaller size that costs less (e.g. 1oz Salve for $14 when base is $20): enter `-6`.
     - For a larger size that costs more (e.g. 8oz Soak for $24.00 when 4oz base is $14.00): enter `10.00`.
   - **⚠️ Character Trap**: Never use the characters `[`, `]`, or `|` inside option names (e.g. write `2 oz Glass Jar`, **not** `2 oz [Jar]`), as those symbols are used internally by the shopping cart.

#### C. The 5 Inventory & Availability States
Manage stock with complete transparency and urgency without artificial hype:

| Desired Storefront Experience | What Customers See | How to Configure in `/admin` |
|---|---|---|
| **1. Made-to-Order / Unlimited** | Standard active "Add to Cart" button | Leave **Stock count** blank (empty) and ensure **In stock** is checked. |
| **2. Low-Stock Urgency Badge** | "Only 3 left! — order soon" warning badge on card | Enter a number from `1` to `5` in **Stock count**. |
| **3. Entire Product Sold Out** | "Sold Out" badge; buy button replaced with "Email Me When Restocked" signup | Enter `0` in **Stock count** OR uncheck **In stock**. |
| **4. Single Variant Sold Out** | Size dropdown displays option greyed out (e.g. "1oz — sold out"; unclickable) | Expand **Variants → Options**, find that option, and switch **Sold out?** to `ON`. *Never delete the option, so customers know you make it and it will return!* |
| **5. Coming Soon / Launch Signup** | "Coming Soon" badge; buy button replaced with "Email Me When It Launches" signup | Switch **Coming soon** to `ON` (checked). |

---

### Walkthrough 2: Multi-Buy Volume Deals (`volumePricing`)

Multi-buy deals encourage customers to mix and match multiple items within a category to unlock volume savings (e.g., *Buy 2 or more 2oz Salves for $15 each*, regularly $20 each).

#### How Multi-Buy Works in the Cart:
- If a customer adds 1x *Frankincense Salve (2oz)* ($20), it rings up at $20.
- As soon as they add 1x *Sleep Salve (2oz)* ($20), the cart detects 2 qualifying items in `salves`, drops BOTH to $15 each, and totals $30 with a cheerful savings announcement!
- If they add a 3rd qualifying salve, it also receives the $15 rate ($45 total).

#### How to Create or Adjust a Volume Deal:
1. In `/admin`, open **Shop & Products**.
2. Click to expand **Multi-buy deals** right beneath Products.
3. Click an existing rule (e.g., `2oz Salve Multi-Buy`) or click **Add Deal**:
   - **Deal ID**: A clean lowercase code with dashes (e.g. `salves-2oz`, `soaks-multi`).
   - **Deal name**: A descriptive title for your reference (e.g. `2oz Salve Multi-Buy`).
   - **Category**: Select the category from the dropdown (e.g. `Salves & Balms`).
   - **Qualifying variant** *(optional)*:
     - Type a specific variant label (e.g. `2oz`) if the deal only applies to that specific size. (1oz jars or balves in other sizes remain unaffected).
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
5. **Sale name shoppers see**: Enter the badge headline (e.g. `Spring Body Care Sale`).
6. Click **Save**. Every item in that category automatically shows a sale badge, calculated discount price, and crossed-out regular price.

#### B. Single-Product Sale
Put just one item on flash sale:
1. In **Products**, open the item.
2. Expand the **Sale** box.
3. Enter the **Sale price ($)** (e.g. `15.00`) and the **Sale name shoppers see** (e.g. `Flash Sale`).
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
| **Shop FAQ** | `FAQ` | Add or edit question & answer pairs displayed in the FAQ accordion on the Shop and Contact pages. |

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
2. (The page title and intro line shown above the post list live under **Site Settings → Journal page**.)
3. Enter the title, date, and a **Short teaser** (1–2 sentences for card previews).
4. Write your story in the main content box using the formatting toolbar (bold, italics, headings, bullet lists).
5. Estimated reading time calculates automatically when published!

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
   - Apothecary Journal Blog (currently **off**: the nav link, the page, the
     RSS feed and the search index all stay empty until you switch it on)
   - UGC Social Feed

   **Two switches in that panel no longer switch anything.** They are still
   drawn by the dashboard, but the features behind them have been withdrawn,
   so ticking or unticking them changes nothing on the live site. They should
   be removed from the dashboard next time `admin/config.yml` is touched:

   - **Show Customer Rewards Points** (`enableLoyaltyPoints`, and the four
     related "Rewards Currency" fields). Nothing ever credited points -- the
     only balance was in the shopper's own browser -- and the redeem button
     called an endpoint that minted real store credit for anyone who asked.
     The earn message, the cart counter and the redeem button are all removed
     until there is a real, server-side points ledger. Offer a discount code
     instead; that is a reward the shop can actually honour.
   - **Show Order Lookup Tool** (`enableOrderStatusLookup`). The lookup
     answered every enquiry with the same invented "Order Confirmed" order,
     whatever was typed into it, and the toggle was read by nothing even then.
     `/order-status` is now an honest contact hand-off: it takes the order
     reference and points the customer at email.

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
| **Set up 2+ Multi-Buy Deal** | `1. Products` → `Multi-buy deals` | Shoppers mixing qualifying items get auto unit discounts |
| **Run category % off sale** | `1. Products` → `Category sales` | Sale banner, strikethrough prices & cart discounts |
| **Create gift bundle** | `1. Products` → `Bundles` → Pick products & discount % | Pre-made set with auto-calculated price |
| **Change free shipping minimum** | `1. Products` → `Shop details & shipping` → `Free shipping threshold` | Progress bar & checkout threshold update |
| **Add market / pop-up date** | `2. Markets` → Add event (include ZIP code!) | Shows on event list & calculates pickup tax |
| **Feature customer review** | `Customer Reviews` → Check "Feature on homepage?" | Displays in homepage testimonials carousel |
| **Publish blog post** | `4. Apothecary Journal` → Add post with visual editor | Live blog article with calculated read time |
| **Update hero / About story** | `Site Settings` | Text and photos update across homepage & About |
| **Toggle site features** | `Site Settings` → `⚙️ Site Settings` | Turn quiz, rewards, ticker, or pickup on/off |

---

*Made with love in Landrum, South Carolina. Y'all Means All.*
