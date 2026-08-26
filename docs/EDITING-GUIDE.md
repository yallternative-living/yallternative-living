# Editing Y'allternative Living — a plain-English guide for Savanna

You do **not** need to be a coder to run this shop. This guide covers the easy
way (a point-and-click editor) and the "just edit the file" way, plus how photos
and prices work. Nothing here touches money or checkout — that's Stripe (see
`docs/DEVELOPMENT.md` section 8, or `docs/SETUP-GUIDE.md` for the click-by-click
version of linking every external account).

---

## The easy way: the product editor at `/admin`

Once the site is live, go to **yourdomain.com/admin** and log in with GitHub
(two easy ways — see "How to log in" just below; **you do not need Netlify** for
this). You'll get a form-based editor (no code) for everything in your catalog:

- **1. Products, Bundles & FAQ** — Add a new product, edit pricing, descriptions, ingredients, scent, size variants, upload photos, manage bundles/gift sets, or update FAQ answers. Item IDs are automatically generated for you. *If one size or scent runs out, don't delete the option — flip its **Sold out?** toggle instead. It shows greyed out ("S — sold out") in the shop so folks know it exists and is coming back, and it can't be ordered. Flip it back off when you restock.*
- **2. Markets, Fairs & Pride Dates** — Add or edit market appearances. Upcoming dates display chronologically and past dates automatically archive under "Where We've Been". *Fill in the **ZIP code** for any market where customers can pick up an online order: sales tax is based on where they actually collect it, and each county charges slightly differently, so the ZIP is what gets the amount right.*
- **3. Customer Reviews** — Publish on-site customer reviews and choose which ones feature on the homepage testimonials grid.
- **4. Apothecary Journal (Blog)** — Write and publish stories, kitchen updates, and announcements. *The big post box has a formatting toolbar — bold, italic, links, headings, and bullet or numbered lists all come out on the website looking the way they look in the box. The "short teaser" above it stays plain text on purpose: it's the one-or-two-sentence blurb on the blog list page.*
- **5. Social Media Feed** — Curate and toggle Instagram/TikTok post previews on the homepage.
- **6. Site Images & Page Wording** — Choose and update non-product photos (homepage hero banner, homepage story photo, About bio photo, About secondary photo, Shop gift card banner, Contact page feature photo, desktop/mobile site logos, and social media preview OG image) or edit section headlines, hero paragraphs, contact form placeholders, direct email link, global site settings (API keys, tracking, live chat), and turn individual features on/off (Restock Alerts, Custom Box Builder, Scent Filter, Rewards Points, Apothecary Quiz, and more — see `docs/SETUP-GUIDE.md` Step 9 for the full list).

When you hit **Save**, it records the change and the site rebuilds and
re-publishes itself automatically — you don't run anything. Changes usually go
live within a couple of minutes.

### How to log in (two easy ways — no Netlify needed)

**Heads-up:** Netlify's old "Log in with GitHub" switch is **deprecated** — if
you hit a "This feature is deprecated" warning while poking around Netlify, that
was the old, dead path. Ignore it. Your login works one of these two ways
instead:

1. **Sign in with Token — works right now, nothing for Steven to set up.**
   Make a GitHub token and paste it in. Step-by-step is in
   **docs/SETUP-GUIDE.md → Step 9** ("Fastest, works right now"). This is the
   quickest way to start editing today.
2. **Sign in with GitHub button — the nicer permanent login.** Steven does a
   one-time setup once (a GitHub OAuth App + a tiny Cloudflare login service —
   **DEVELOPMENT.md section 20, Option B**). After that, `/admin` just shows a
   **Sign in with GitHub** button and there's no token to keep track of.

The repo is already pointed at the real GitHub project (`admin/config.yml`'s
`backend.repo`) — nothing to change there. The site is deployed on Netlify
(already configured, and it's what the live site runs on); Netlify hosts the
pages, it just no longer handles the `/admin` login.

If you'd rather not deal with `/admin` at all yet, the "edit the file" way below
still works.

---

## The "edit the file" way (Steven, or a brave owner)

Everything in the catalog lives in **one file**:
`assets/data/products.json`. It's plain, readable text. To change a price, find
the product and change its `"price"` number. To fix a typo, edit the `"blurb"`.

After editing, run **one command** to update the whole site:

```
npm run build-data
```

That regenerates every derived file (the shop page's search data, the sitemap,
the SEO/structured data, the AI-crawler summary) from your one file. Then check
nothing broke:

```
npm test
```

(First time only, in the project folder: `npm install`.)

---

## Photos

- **Add/replace a product photo:** put the image in `assets/img/` named to match
  the product (e.g. `sleep-salve.jpg`, extra angles `sleep-salve-alt1.jpg`), then
  run:

  ```
  npm run optimize-images
  ```

  That makes the fast, modern versions of the image the site serves. (If you
  upload a photo through `/admin` it will show up, but run this command — or ask
  Steven to add it to the deploy — so it's fully optimized.)
- **Five products are on a "Photo coming soon" placeholder** right now
  (`Y'all Means All Sugar Scrub`, `Y'all Means All Rainbow Whipped Body Butter`, `Appalachian Rain Clearing Mist`, `Moonlit Meadow Bath Tea`, and `Porch Sweep Clearing Mist`). Swap in real
  photos the same way, and double-check their price and ingredients while you're
  there. These same five are marked `comingSoon: true` in `/admin`, which is
  what shows an "Email me when it launches" signup instead of Add to Cart on
  the shop page — once a product actually has real photos and is ready to
  sell, switch its Coming Soon toggle off in `/admin` and it goes back to a
  normal, buyable listing automatically.
- **Non-product site photos (About bio photo, homepage hero, logos, social share image, etc.):** You can easily choose different photos or upload new ones directly in `/admin` under **6. Site Images & Page Wording**. Click **Choose an image** to select any photo from your media library or upload a new image file. Upon save, the site's build script automatically links it, updates metadata, and generates responsive breakpoints.

---

## What the editor does *not* cover (still needs Steven)

Honest heads-up — the catalog is owner-friendly; a few things still live in the
page files:

- **Legal policies** — the privacy, terms, and shipping policy pages are in `privacy.html`, `terms.html`, and `policies.html`. These are not editable in `/admin` and still require a quick edit from Steven to keep the formatting robust. (The homepage headline/intro, About story, contact photo, site logos, social share image, and integration settings/API keys ARE now editable in `/admin` under "Site Images & Page Wording".)

---

## Cheat sheet

| I want to… | Where | Live how |
|---|---|---|
| Change a price | `/admin` → the product, or `products.json` | Auto (CMS) / `npm run build-data` |
| Add a product | `/admin`, or `products.json` | same |
| Add a gift bundle | `/admin` → Bundles, or `products.json` | same |
| Edit shipping/returns FAQ | `/admin` → FAQ, or `products.json` | same |
| Publish a customer review | `/admin` → Customer Reviews, or `site-reviews.json` | same |
| Swap a product photo | `assets/img/` + `npm run optimize-images` | on next deploy |
| Add a market/Pride date | `/admin` → Markets, or `events.json` | Auto (CMS) / `npm run build-data` |
| Choose different hero/bio/site photos | `/admin` → Site Images & Page Wording, or `content.json` | Auto (CMS) / `npm run build-data` |
| Reword homepage headline / About story | `/admin` → Site Images & Page Wording, or `content.json` | Auto (CMS) / `npm run build-data` |

**Rule of thumb:** products, prices, bundles, FAQ, photos, market dates, site logos, integration API keys, and page wording (About / homepage / contact text) = you, via `/admin`. Only the legal policies and underlying layout structures = a quick edit from Steven.
