# Editing Y'allternative Living — a plain-English guide for Savanna

You do **not** need to be a coder to run this shop. This guide covers the easy
way (a point-and-click editor) and the "just edit the file" way, plus how photos
and prices work. Nothing here touches money or checkout — that's Snipcart.

---

## The easy way: the product editor at `/admin`

Once the site is live, go to **yourdomain.com/admin** and log in with GitHub.
You'll get a form-based editor (no code) for everything in your catalog:

- **Products** — add a new one, edit a name, description, price, ingredients,
  variants (sizes/scents), or upload a photo.
- **Bundles / gift sets** — build a set by picking products and a discount.
- **FAQ** — the shipping/returns questions shown at checkout and on Contact.
- **Shop info** — your Etsy rating, review count, and sales number.
- **Markets, fairs & Pride dates** — add or edit where you'll be in person; the
  Events page updates itself and old dates drop off automatically.
- **Customer reviews** — publish a review a customer sent you. (These stay
  separate from your Etsy star rating, so nothing is ever misrepresented.)
- **Homepage headline & your About story** — reword the big homepage line and
  its intro, and the "Meet Savanna" story, under **Page Wording** in the editor.

When you hit **Save**, it records the change and the site rebuilds and
re-publishes itself automatically — you don't run anything. Changes usually go
live within a couple of minutes.

### One-time setup before `/admin` works (a developer does this once)

The editor is already built; it just needs three things that are part of
launching the site (see **README section 20** for the click-by-click):

1. Put this project in a **GitHub repo** (replace the placeholder in
   `admin/config.yml`: `YOUR_GITHUB_USERNAME/YOUR_REPO_NAME`).
2. **Deploy** the site (Netlify or GitHub Pages — both are already configured).
3. Turn on **login** (on Netlify, its GitHub OAuth needs one checkbox; on GitHub
   Pages you point it at a small auth helper). README section 20 has the steps.

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
- **Two products are on a "Photo coming soon" placeholder** right now
  (`Y'all Means All Sugar Scrub`, `Rainbow Whipped Body Butter`). Swap in real
  photos the same way, and double-check their price and ingredients while you're
  there.
- **A real photo of you** for the "Meet Savanna" / homepage spots: drop it in
  `assets/img/` and it can replace the current placeholder — ask your developer
  to wire it into `about.html` and `index.html`.

---

## What the editor does *not* cover (still needs a developer)

Honest heads-up — the catalog is owner-friendly; a few things still live in the
page files:

- **Privacy-policy wording** — the privacy policy text is in `privacy.html`, not
  the `/admin` editor. (The homepage headline/intro and your About story ARE now
  editable in `/admin` under "Page Wording"; only the legal policy page isn't.)

These are easy edits for anyone comfortable in a text editor, and they could be
added to the `/admin` editor later if you want to manage them yourself too.

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

**Rule of thumb:** products, prices, bundles, FAQ, photos, and market dates =
you, via `/admin`. Page stories (About / homepage / policies) = a quick
developer edit (for now).
