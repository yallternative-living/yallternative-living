# Editing Y'allternative Living — a plain-English guide for Savanna

You do **not** need to be a coder to run this shop. This guide covers the easy
way (a point-and-click editor) and the "just edit the file" way, plus how photos
and prices work. Nothing here touches money or checkout — that's Stripe (see
`docs/DEVELOPMENT.md` section 8).

---

## The easy way: the product editor at `/admin`

Once the site is live, go to **yourdomain.com/admin** and log in with GitHub.
You'll get a form-based editor (no code) for everything in your catalog:

- **1. Products, Bundles & FAQ** — Add a new product, edit pricing, descriptions, ingredients, size variants, upload photos, manage bundles/gift sets, or update FAQ answers. Item IDs are automatically generated for you.
- **2. Markets, Fairs & Pride Dates** — Add or edit market appearances. Upcoming dates display chronologically and past dates automatically archive under "Where We've Been".
- **3. Customer Reviews** — Publish on-site customer reviews and choose which ones feature on the homepage testimonials grid.
- **4. Apothecary Journal (Blog)** — Write and publish stories, kitchen updates, and announcements.
- **5. Social Media Feed** — Curate and toggle Instagram/TikTok post previews on the homepage.
- **6. Page Headlines & Wording** — Edit section headlines, hero paragraphs, contact form placeholders, direct email link, and global site settings (API keys, tracking, live chat).

When you hit **Save**, it records the change and the site rebuilds and
re-publishes itself automatically — you don't run anything. Changes usually go
live within a couple of minutes.

### One-time setup before `/admin` works (a developer does this once)

The editor is already built; it just needs three things that are part of
launching the site (see **DEVELOPMENT.md section 20** for the click-by-click):

1. Put this project in a **GitHub repo** (replace the placeholder in
   `admin/config.yml`: `YOUR_GITHUB_USERNAME/YOUR_REPO_NAME`).
2. **Deploy** the site (Netlify or GitHub Pages — both are already configured).
3. Turn on **login** (on Netlify, its GitHub OAuth needs one checkbox; on GitHub
   Pages you point it at a small auth helper). DEVELOPMENT.md section 20 has the steps.

Until those are done, use the "edit the file" way below.

---

## The "edit the file" way (a developer, or a brave owner)

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
  your developer to add it to the deploy — so it's fully optimized.)
- **Five products are on a "Photo coming soon" placeholder** right now
  (`Y'all Means All Sugar Scrub`, `Y'all Means All Rainbow Whipped Body Butter`, `Appalachian Rain Clearing Mist`, `Moonlit Meadow Bath Tea`, and `Porch Sweep Clearing Mist`). Swap in real
  photos the same way, and double-check their price and ingredients while you're
  there.
- **Static page photos (About bio photo, homepage hero, logos, etc.):** You can replace these directly in `/admin` under **Page Wording**. Upload the new photo in the editor, and the site's build script will automatically wire it in, optimize it, and generate the responsive breakpoints.

---

## What the editor does *not* cover (still needs a developer)

Honest heads-up — the catalog is owner-friendly; a few things still live in the
page files:

- **Legal policies** — the privacy, terms, and shipping policy pages are in `privacy.html`, `terms.html`, and `policies.html`. These are not editable in `/admin` and still require a developer edit to keep the formatting robust. (The homepage headline/intro, About story, contact photo, site logos, and integration settings/API keys ARE now editable in `/admin` under "Page Wording".)

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
| Reword homepage headline / About story | `/admin` → Page Wording, or `content.json` | Auto (CMS) / `npm run build-data` |

**Rule of thumb:** products, prices, bundles, FAQ, photos, market dates, site logos, integration API keys, and page wording (About / homepage / contact text) = you, via `/admin`. Only the legal policies and underlying layout structures = a quick developer edit.
