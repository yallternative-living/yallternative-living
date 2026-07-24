# Self-hosting the fonts (Gloock + DM Sans)

Right now the site loads Gloock and DM Sans from Google Fonts. That works and is
already loaded non-render-blocking, but self-hosting is a small upgrade: no
third-party origin on the critical path, one fewer DNS+TLS handshake, tighter
CSP, and — with font-metric overrides — near-zero layout shift when the font
swaps in.

This is **not applied yet** because the WOFF2 binaries have to be fetched from
your machine (they can't be pulled into this workspace). It's one command plus a
few edits.

## 1. Download the fonts

```bash
node scripts/self-host-fonts.js
```

This writes `assets/fonts/gloock-400.woff2`, `dm-sans-400.woff2`,
`dm-sans-500.woff2`, `dm-sans-700.woff2`.

## 2. Add @font-face + a metric-matched fallback

Replace the `@font-face { font-family: 'CleanAmpersand'; ... }` block near the
top of `assets/css/styles.css` (and set the `--font-*` variables) with:

```css
@font-face {
  font-family: 'Gloock';
  src: url('/assets/fonts/gloock-400.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'DM Sans';
  src: url('/assets/fonts/dm-sans-400.woff2') format('woff2');
  font-weight: 400; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'DM Sans';
  src: url('/assets/fonts/dm-sans-500.woff2') format('woff2');
  font-weight: 500; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'DM Sans';
  src: url('/assets/fonts/dm-sans-700.woff2') format('woff2');
  font-weight: 700; font-style: normal; font-display: swap;
}

/* Metric-matched fallback: sized to line up with DM Sans so text doesn't
   reflow when the real font loads. Generate exact override numbers for your
   fonts with @capsizecss/core `createFontStack()` or the Fontaine plugin —
   the values below are a sensible DM-Sans-vs-Arial starting point. */
@font-face {
  font-family: 'DM Sans Fallback';
  src: local('Arial');
  ascent-override: 92%;
  descent-override: 24%;
  line-gap-override: 0%;
  size-adjust: 100%;
}

:root {
  --font-display: 'Gloock', Georgia, serif;
  --font-body: 'DM Sans', 'DM Sans Fallback', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
```

> For pixel-perfect zero-CLS numbers, run the fonts through
> `npx @capsizecss/core` (or the Fontaine plugin) — it reads the actual font
> metrics and emits the exact `ascent-override` / `descent-override` /
> `size-adjust`. The starting values above already remove most of the shift.

## 3. Swap the `<head>` links on every page

In each HTML file, delete the four Google Fonts lines:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preload" as="style" href="https://fonts.googleapis.com/css2?...">
<link rel="stylesheet" ... href="https://fonts.googleapis.com/css2?..." media="print" onload="...">
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?..."></noscript>
```

…and add one preload for the body font (the one used above the fold), before
the stylesheet link:

```html
<link rel="preload" as="font" type="font/woff2"
      href="/assets/fonts/dm-sans-400.woff2" crossorigin>
```

## 4. Update the CSP

In `scripts/build-security-headers.js`, remove
`https://fonts.googleapis.com` from `style-src` and
`https://fonts.gstatic.com` from `font-src` (the self-hosted files are covered
by `'self'`). Then:

```bash
npm run build-security-headers
```

## 5. Add the fonts to the service-worker precache (optional but nice)

Add the four `/assets/fonts/*.woff2` paths to `ASSETS_TO_CACHE` in `sw.js` so
they're available offline.

## 6. Verify

```bash
npm run test          # qa-check.js
npm run test:integration
```

Then load the site and confirm headings (Gloock) and body (DM Sans) render, with
no flash of a different font and no layout jump.
