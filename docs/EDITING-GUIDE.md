# Editing Y'allternative Living — A Plain-English Guide for Savanna

Hey Savanna! Welcome to your shop's management guide. You do **not** need to be a coder or web developer to run Y'allternative Living. This guide is written specifically for you to manage products, adjust prices, run multi-buy volume deals, launch sales, update market schedules, and share stories easily.

Nothing in this dashboard touches customer credit card numbers or sensitive payment info — Stripe securely handles checkout and transactions behind the scenes (see `docs/DEVELOPMENT.md` section 8, or `docs/SETUP-GUIDE.md` for account connections).

---

## 1. Your Dashboard Overview: The Editor at `/admin`

Whenever you want to make changes to the live site, open **yourdomain.com/admin** in any web browser and log in (see [How to Log In](#2-how-to-log-in) below).

Your dashboard is organized into 7 focused sections in the left sidebar. The **Journal** sits under the **Collections** heading at the top and shows your list of posts; every other section sits under **Files** below it and opens straight into its editor when you click it (the editor's header says "Files" for those, but the highlighted item in the sidebar tells you where you are). The numbers match the walkthroughs in this guide, not the order on screen:

1. **1. Products, Bundles & FAQ** — Your daily workspace:
   - **Products (Top Priority)**: Manage your 19 catalog items, edit prices, set size/scent variants, upload photos, add ingredients, and update stock levels.
   - **Volume Pricing Rules (Promotions & Deals)**: Set up mix-and-match multi-buy category tiers (like *Any 2+ 2oz Salves for $15 each*).
   - **Category Sales**: Put whole categories on sale at once with percentage discounts (e.g. *15% off Body & Skin*).
   - **Bundles / Pre-made Gift Sets**: Create curated gift sets (*Discovery Flight*, *Everyday Armor Kit*) with auto-calculated bundle pricing.
   - **FAQ (Shop & Contact Accordion)**: Update questions and answers on shipping, returns, shelf life, and custom orders.
   - **Shop Filter Categories & Shop Settings**: Category filter buttons, Etsy sync counters, free shipping threshold, and Build-Your-Own Box settings (neatly tucked at the bottom).
2. **2. Markets, Fairs & Pride Dates** — Add upcoming pop-up markets, craft fairs, and Pride events. Upcoming dates display chronologically, and past appearances automatically archive themselves under "Where We've Been."
3. **3. Customer Reviews** — Publish customer reviews and choose which glowing testimonials feature on the homepage carousel.
4. **4. Journal** — Each post is its own entry with a **New Post** button. Write kitchen updates, herbal deep-dives, and community announcements with a visual formatting toolbar.
5. **5. Social Media Feed** — Feature your favorite Instagram and TikTok posts directly on the homepage.
6. **6. Site Images & Page Wording** — Update homepage hero copy, About page story, bio photos, logos, social share images, and toggle site features on or off.
7. **7. Quiz** — The questions, answer options, and product recommendations behind the Apothecary Recommendation Quiz.

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

### Walkthrough 1: Products, Pricing, Variants & Stock Levels

#### A. Changing a Product's Base Price
1. In `/admin`, click **1. Products, Bundles & FAQ**.
2. Under **Products**, click the item you want to edit (e.g., *Y'all Heal Now Miracle Frankincense Salve*).
3. Find the **Price (USD)** field and type the new price (e.g. `20`).
4. Click **Save** in the top bar. All bundle discounts, cart calculations, and SEO tags update automatically!

#### B. Adding Sizes, Scents, or Style Variants (with `priceDelta`)
For products available in different sizes (e.g. 1oz vs 2oz salve, 4oz vs 8oz soak) or scent blends:
1. Open the product and expand the **Size/Scent/Blend Variants** section.
2. Set **Variant Type Label** to `Size`, `Scent`, `Blend`, or `Option`.
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
| **1. Made-to-Order / Unlimited** | Standard active "Add to Cart" button | Leave **Stock Count** blank (empty) and ensure **In Stock** is checked. |
| **2. Low-Stock Urgency Badge** | "Only 3 left! — order soon" warning badge on card | Enter a number from `1` to `5` in **Stock Count**. |
| **3. Entire Product Sold Out** | "Sold Out" badge; buy button replaced with "Email Me When Restocked" signup | Enter `0` in **Stock Count** OR uncheck **In Stock**. |
| **4. Single Variant Sold Out** | Size dropdown displays option greyed out (e.g. "1oz — sold out"; unclickable) | Expand **Variants → Options**, find that option, and switch **Sold out?** to `ON`. *Never delete the option, so customers know you make it and it will return!* |
| **5. Coming Soon / Launch Signup** | "Coming Soon" badge; buy button replaced with "Email Me When It Launches" signup | Switch **Coming Soon Product** to `ON` (checked). |

---

### Walkthrough 2: Multi-Buy Volume Deals (`volumePricing`)

Multi-buy deals encourage customers to mix and match multiple items within a category to unlock volume savings (e.g., *Buy 2 or more 2oz Salves for $15 each*, regularly $20 each).

#### How Multi-Buy Works in the Cart:
- If a customer adds 1x *Frankincense Salve (2oz)* ($20), it rings up at $20.
- As soon as they add 1x *Sleep Salve (2oz)* ($20), the cart detects 2 qualifying items in `salves`, drops BOTH to $15 each, and totals $30 with a cheerful savings announcement!
- If they add a 3rd qualifying salve, it also receives the $15 rate ($45 total).

#### How to Create or Adjust a Volume Deal:
1. In `/admin`, open **1. Products, Bundles & FAQ**.
2. Click to expand **Volume Pricing Rules (Multi-Buy Deals)** right beneath Products.
3. Click an existing rule (e.g., `2oz Salve Multi-Buy`) or click **Add Volume Pricing Rule**:
   - **Rule ID**: A clean lowercase code with dashes (e.g. `salves-2oz`, `soaks-multi`).
   - **Rule Name**: A descriptive title for your reference (e.g. `2oz Salve Multi-Buy`).
   - **Category**: Select the category from the dropdown (e.g. `Salves & Balms`).
   - **Qualifying Variant** *(optional)*:
     - Type a specific variant label (e.g. `2oz`) if the deal only applies to that specific size. (1oz jars or balves in other sizes remain unaffected).
     - Leave blank if *all* products and sizes in that category qualify.
   - **Minimum Quantity**: The quantity threshold needed to activate the discount (e.g. `2`).
   - **Discounted Unit Price ($ USD)**: The discounted unit price (e.g. `15`).
   - **Promotional Label**: The badge copy shown on product cards and cart summaries (e.g. `2+ for $15 each`).
   - **Rule Enabled**: Toggle `ON` to run the deal, or toggle `OFF` to pause the promotion anytime without deleting your setup.
4. Click **Save**.

---

### Walkthrough 3: Category Sales & Single-Item Sales

#### A. Running a Storewide Category Sale (`sales`)
Put an entire category on sale at once (e.g. 15% off all *Body & Skin*):
1. In `/admin` → **1. Products, Bundles & FAQ**, open **Category Sales**.
2. Click **Add Sale**.
3. **Which category is on sale**: Pick the category from the dropdown (e.g. `Body & Skin`).
4. **Percent off**: Type the percentage discount (e.g. `15` for 15% off).
5. **Sale name shoppers see**: Enter the badge headline (e.g. `Spring Body Care Sale`).
6. Click **Save**. Every item in that category automatically shows a sale badge, calculated discount price, and crossed-out regular price.

#### B. Single-Product Sale
Put just one item on flash sale:
1. In **Products**, open the item.
2. Expand the **Sale (optional)** box.
3. Enter the **Sale price ($)** (e.g. `15.00`) and the **Sale name shoppers see** (e.g. `Flash Sale`).
4. In **Original price**, enter the regular price (e.g. `20`) so the crossed-out comparison price appears.
5. Click **Save**.

---

### Walkthrough 4: Curated Gift Sets & Bundles (`bundles`)

Bundles are pre-curated collections (like the *Grit & Grace Starter Set* or *Discovery Flight*).

- **Dynamic Math (No Price to Type!)**: Bundle prices calculate automatically from the live prices of whatever items are inside, minus your discount percentage. If you update a salve's price, every bundle containing that salve recalculates its price automatically.
- **How to Create or Edit a Bundle**:
  1. In `/admin` → **1. Products, Bundles & FAQ**, open **Bundles / Pre-made Gift Sets**.
  2. Click **Add Bundle** or click an existing bundle to edit.
  3. **Bundle Name**: Give your gift set a warm name (e.g. `Backwoods Burnout Recovery Kit`).
  4. **Products in this bundle**: Select 2 or more products by typing and clicking their real product names from the searchable dropdown list.
  5. **Discount Percent**: Enter the discount percentage (e.g. `10` for 10% off, or `15` for 15% off).
  6. **Bundle Description**: Write a vivid description of who it's for and what's inside.
  7. Click **Save**.

---

### Walkthrough 5: Shop Settings, Technical Filters & Navigation

Tucked neatly at the bottom of **1. Products, Bundles & FAQ**:

| Setting | Where to Find It | What It Controls |
|---|---|---|
| **Free Shipping Threshold** | `⚙️ Shop Metadata & Shipping Settings` | Set the dollar amount where shipping becomes free (default is `$40`). Set to `0` to disable free shipping. |
| **Etsy Live Counters** | `⚙️ Shop Metadata & Shipping Settings` | Update your live Etsy star rating (e.g. `4.9`), review count (e.g. `32`), and total sales (e.g. `105`) to keep your site trust badges synced. |
| **Build-Your-Own Box** | `⚙️ Shop Metadata & Shipping Settings` | Set minimum items (e.g. `3`), maximum items (e.g. `5`), discount percent (e.g. `10%`), and select eligible categories for custom boxes. |
| **Shop Filter Categories** | `Shop Filter Categories (Technical)` | Add or rename category buttons across the top of `/shop.html`. |
| **Shop FAQ** | `FAQ (Shop & Contact Accordion)` | Add or edit question & answer pairs displayed in the FAQ accordion on the Shop and Contact pages. |

---

### Walkthrough 6: Pop-Ups, Reviews, Blog, Social Feed & Site Settings

#### A. Pop-Up Markets & Pride Events (Collection 2)
1. Click **2. Markets, Fairs & Pride Dates** in the sidebar.
2. Click **Add Event** under **Upcoming pop-ups**.
3. Fill in the event title, start date (and end date if multi-day), friendly date label (e.g. `Saturday, Oct 12 · 9am–2pm`), location, and event link.
4. **⚠️ Crucial Sales Tax Note**: Always enter the **5-digit ZIP code** for any market where customers can select "Local Market Pickup" during online checkout. Sales tax in South Carolina is based on the exact pickup location, so the ZIP code ensures accurate tax calculation.

#### B. Publishing Customer Reviews (Collection 3)
1. Click **3. Customer Reviews** in the sidebar.
2. Click **Add Review**.
3. Enter the customer's name, star rating (1–5), review text, and select the product from the dropdown.
4. Check **Feature on homepage?** to showcase their review in the homepage testimonial carousel.

#### C. Journal / Blog (Collection 4)
1. Click **4. Journal** in the sidebar to see the list of posts. Click a post to edit it, or **New Post** (top right) to write one.
2. (The page title and intro line shown above the post list live under **6. Site Images & Page Wording → Journal page**.)
3. Enter the title, date, and a **Short teaser** (1–2 sentences for card previews).
4. Write your story in the main content box using the formatting toolbar (bold, italics, headings, bullet lists).
5. Estimated reading time calculates automatically when published!

#### D. Social Media Feed (Collection 5)
1. Click **5. Social Media Feed**.
2. Add new Instagram or TikTok post snapshots with photos, captions, and tagged products.

#### E. Site Images & Page Wording (Collection 6)
1. Click **6. Site Images & Page Wording**.
2. Update homepage headlines, About page story text, or swap non-product photos (homepage hero banner, About bio photo, site logos).
3. Under **⚙️ Site Settings**, you can toggle features on or off anytime with simple checkboxes:
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
  2. Switch **Coming Soon Product** to `OFF`.
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
| **Mark whole item sold out** | `1. Products` → Set `Stock Count` to 0 or uncheck `In Stock` | Shows "Sold Out" badge & Restock Email signup |
| **Show low stock urgency** | `1. Products` → Set `Stock Count` to 1, 2, 3, 4, or 5 | Shows "Only X left! — order soon" badge |
| **Set up 2+ Multi-Buy Deal** | `1. Products` → `Volume Pricing Rules` | Shoppers mixing qualifying items get auto unit discounts |
| **Run category % off sale** | `1. Products` → `Category Sales` | Sale banner, strikethrough prices & cart discounts |
| **Create gift bundle** | `1. Products` → `Bundles` → Pick products & discount % | Pre-made set with auto-calculated price |
| **Change free shipping minimum** | `1. Products` → `Shop Settings` → `Free shipping threshold` | Progress bar & checkout threshold update |
| **Add market / pop-up date** | `2. Markets` → Add event (include ZIP code!) | Shows on event list & calculates pickup tax |
| **Feature customer review** | `3. Customer Reviews` → Check "Feature on homepage?" | Displays in homepage testimonials carousel |
| **Publish blog post** | `4. Apothecary Journal` → Add post with visual editor | Live blog article with calculated read time |
| **Update hero / About story** | `6. Site Images & Page Wording` | Text and photos update across homepage & About |
| **Toggle site features** | `6. Site Images & Page Wording` → `⚙️ Site Settings` | Turn quiz, rewards, ticker, or pickup on/off |

---

*Made with love in Landrum, South Carolina. Y'all Means All.*
