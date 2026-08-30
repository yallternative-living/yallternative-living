#!/usr/bin/env node
"use strict";

/* ==========================================================
   Y'ALLTERNATIVE LIVING -- responsive AVIF+WebP image pipeline
   ----------------------------------------------------------
   Generates small/medium/full AVIF *and* WebP variants for every
   product photo in assets/img/, then writes
   assets/js/image-manifest.js so the site's <picture> markup always
   knows exactly which variants exist and how wide each one is.

   AVIF goes first in the <picture> markup (main.js) because it's
   the better-compressing modern format (2026 browser support is
   effectively universal on anything that isn't ancient); WebP is
   the fallback for the rare holdout, and the original JPG is the
   final safety net for anything that supports neither.

   This ALSO runs automatically on every deploy (netlify.toml /
   vercel.json, before build-site-data.js so new variants land in the
   generated <picture> markup) -- so a photo uploaded through /admin
   gets optimized without anyone running anything. Incremental: photos
   whose variants already exist and whose source is unchanged are
   skipped, so a no-new-photos deploy costs ~2 seconds.

   Run it by hand any time a new product photo gets dropped into
   assets/img/ locally -- HOW TO ADD A NEW PRODUCT PHOTO:
     1. Drop the new .jpg into assets/img/
     2. Reference it from assets/js/products-data.js as usual
     3. Run: node scripts/optimize-images.js
        (or: npm run optimize-images)
   That regenerates both formats' variants and the manifest so the
   new photo gets the same fast, responsive treatment automatically
   -- nobody has to remember a manual conversion step.

   This is a dev-time build tool only. Requires the "sharp"
   devDependency (see package.json). The deployed site itself
   stays 100% static HTML/CSS/JS -- sharp never ships, it just
   pre-generates files that get committed/deployed alongside
   everything else.
   ========================================================== */

const fs = require("fs");
const path = require("path");

// sharp is a devDependency, and this script now runs as the first step of
// every deploy (see netlify.toml / vercel.json). If a host ever skips
// devDependencies -- setting NODE_ENV=production is the usual way -- a hard
// require here would abort the whole build, which on this site means a CMS
// edit silently never goes live. Photos being unoptimized is a slow page;
// a failed deploy is no page at all, so degrade instead of dying: warn,
// leave whatever variants are already committed in place, and let the rest
// of the build run.
let sharp;
try {
  sharp = require("sharp");
} catch (err) {
  console.warn(
    "\n[optimize-images] sharp is not installed -- skipping image optimization.\n" +
      "  Already-committed AVIF/WebP variants still ship; only brand-new photos\n" +
      "  stay full-size. Run `npm install` locally, or make sure the deploy\n" +
      "  installs devDependencies, then re-run to generate the missing ones.\n"
  );
  process.exit(0);
}

const ROOT = path.join(__dirname, "..");
const IMG_DIR = path.join(ROOT, "assets", "img");
const MANIFEST_PATH = path.join(ROOT, "assets", "js", "image-manifest.js");

const WIDTHS = [480, 800]; // plus one "full" variant at the source's own width
const WEBP_QUALITY = 80;
// AVIF's compression curve isn't the same as WebP's -- a lower quality
// number here looks comparable to WEBP_QUALITY=80 while encoding
// smaller, which is the whole point of adding it.
const AVIF_QUALITY = 55;
// libaom's default encode effort (4) is noticeably slower per image than
// WebP for a real gain of only a few percent smaller files -- effort 2
// keeps AVIF's size advantage over WebP while running several times
// faster, which matters when re-encoding dozens of photos at once.
const AVIF_EFFORT = 2;

// Small/UI images that don't need the responsive treatment --
// they're already tiny and used at a fixed, small size everywhere.
const SKIP_EXACT = ["logo.jpg", "logo.png"];

function shouldSkip(filename) {
  if (SKIP_EXACT.indexOf(filename) !== -1) return true;
  if (/^favicon/i.test(filename)) return true;
  return false;
}

async function optimizeOne(filename) {
  const base = filename.replace(/\.(jpe?g|png)$/i, "");
  const srcPath = path.join(IMG_DIR, filename);
  const meta = await sharp(srcPath).metadata();
  const srcWidth = meta.width || 1200;
  const srcHeight = meta.height || Math.round(srcWidth * 0.85);

  const avifVariants = [];
  const webpVariants = [];

  const tasks = [];

  for (let i = 0; i < WIDTHS.length; i++) {
    const w = WIDTHS[i];
    if (w >= srcWidth) continue; // never upscale

    const webpOut = base + "-" + w + ".webp";
    tasks.push(
      sharp(srcPath)
        .resize({ width: w })
        .webp({ quality: WEBP_QUALITY })
        .toFile(path.join(IMG_DIR, webpOut))
    );
    webpVariants.push({ width: w, file: "assets/img/" + webpOut });

    const avifOut = base + "-" + w + ".avif";
    tasks.push(
      sharp(srcPath)
        .resize({ width: w })
        .avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT })
        .toFile(path.join(IMG_DIR, avifOut))
    );
    avifVariants.push({ width: w, file: "assets/img/" + avifOut });
  }

  // Full-size variants, always included, always the widest -- this is
  // what large screens / the srcset's biggest candidate use.
  const fullWebp = base + ".webp";
  tasks.push(sharp(srcPath).webp({ quality: WEBP_QUALITY }).toFile(path.join(IMG_DIR, fullWebp)));
  webpVariants.push({ width: srcWidth, file: "assets/img/" + fullWebp });

  const fullAvif = base + ".avif";
  tasks.push(
    sharp(srcPath)
      .avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT })
      .toFile(path.join(IMG_DIR, fullAvif))
  );
  avifVariants.push({ width: srcWidth, file: "assets/img/" + fullAvif });

  await Promise.all(tasks);

  const beforeSize = fs.statSync(srcPath).size;
  return {
    key: "assets/img/" + filename,
    width: srcWidth,
    height: srcHeight,
    size: beforeSize,
    variants: { avif: avifVariants, webp: webpVariants }
  };
}

/**
 * Writes the image manifest file with a descriptive JSDoc header.
 *
 * @param {!Object} manifest The manifest object containing image details and responsive sizes.
 */
function writeManifest(manifest) {
  const header =
    "/**\n" +
    " * @fileoverview Auto-generated image manifest mapping original product photos\n" +
    " * to responsive AVIF and WebP sizes.\n" +
    " * Do not hand-edit this file.\n" +
    " * @const {!Object}\n" +
    " */\n";
  const body = "window.YL_IMAGES = " + JSON.stringify(manifest, null, 2) + ";\n";
  const dir = path.dirname(MANIFEST_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(MANIFEST_PATH, header + body);
}

function loadExistingManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return {};
  try {
    const stub = {};
    // `window` below is used inside the eval()'d manifest text
    // ("window.YL_IMAGES = ..."), not visible to static analysis, so it
    // looks unused from the linter's view -- it isn't.
    // eslint-disable-next-line no-unused-vars
    (function (window) {
      eval(fs.readFileSync(MANIFEST_PATH, "utf8"));
    }).call(null, stub);
    return stub.YL_IMAGES || {};
  } catch (e) {
    return {};
  }
}

async function run() {
  if (!fs.existsSync(IMG_DIR)) {
    console.log("Creating missing image directory: " + IMG_DIR);
    fs.mkdirSync(IMG_DIR, { recursive: true });
  }
  let files = fs
    .readdirSync(IMG_DIR)
    .filter(function (f) {
      return /\.(jpe?g|png)$/i.test(f) && !shouldSkip(f);
    })
    .sort();

  if (!files.length) {
    console.log("No .jpg product photos found in assets/img/ -- nothing to do.");
    return;
  }

  // Optional: `node scripts/optimize-images.js tank-top,unisex-tshirt`
  // restricts this run to just those base filenames (no extension) --
  // encoding AVIF at real quality is slow enough that doing all 40+
  // photos in one process can take longer than is comfortable in a
  // single terminal session, so batching a few at a time is supported.
  // Every run merges into whatever manifest already exists (and writes
  // it after EACH photo, not just at the end) so a batch that gets
  // interrupted partway never loses previously-finished work.
  const force = process.argv.indexOf("--force") !== -1 || process.argv.indexOf("-f") !== -1;
  const args = process.argv.slice(2).filter(function (arg) {
    return !arg.startsWith("-");
  });
  const onlyArg = args.join(",");
  if (onlyArg) {
    const wanted = onlyArg.split(",").map(function (s) {
      return s.trim();
    });
    files = files.filter(function (f) {
      const base = f.replace(/\.(jpe?g|png)$/i, "");
      return wanted.indexOf(base) !== -1;
    });
    if (!files.length) {
      console.log("No matching files for: " + onlyArg);
      return;
    }
  }

  const manifest = loadExistingManifest();
  let beforeTotal = 0;
  let avifSmallestTotal = 0; // what an AVIF-capable phone actually downloads
  let avifFullTotal = 0; // what an AVIF-capable desktop actually downloads
  let webpSmallestTotal = 0; // same, for the WebP fallback path
  let beforeSize, avifSizes, webpSizes;

  const sizeCache = {};
  const getSize = function (vPath) {
    if (sizeCache[vPath] !== undefined) return sizeCache[vPath];
    try {
      sizeCache[vPath] = fs.statSync(vPath).size;
    } catch (e) {
      sizeCache[vPath] = 0;
    }
    return sizeCache[vPath];
  };

  for (let i = 0; i < files.length; i++) {
    const filename = files[i];
    const fullPath = path.join(IMG_DIR, filename);
    const currentSize = fs.statSync(fullPath).size;
    let entry = manifest["assets/img/" + filename];

    if (!force && entry && entry.size === currentSize && entry.variants) {
      // Check if all variant files actually exist on disk
      let allExist = true;
      const checkVariant = function (v) {
        if (getSize(path.join(ROOT, v.file)) === 0) allExist = false;
      };
      entry.variants.avif.forEach(checkVariant);
      entry.variants.webp.forEach(checkVariant);

      if (allExist) {
        console.log(filename + " is already optimized. Skipping.");
        beforeSize = entry.size || currentSize;
        beforeTotal += beforeSize;
        avifSizes = entry.variants.avif.map(function (v) {
          return getSize(path.join(ROOT, v.file));
        });
        webpSizes = entry.variants.webp.map(function (v) {
          return getSize(path.join(ROOT, v.file));
        });
        avifSmallestTotal += Math.min.apply(null, avifSizes);
        avifFullTotal += avifSizes[avifSizes.length - 1];
        webpSmallestTotal += Math.min.apply(null, webpSizes);
        continue;
      }
    }

    entry = await optimizeOne(filename);
    manifest[entry.key] = entry;
    writeManifest(manifest); // persist after every photo, not just at the end

    beforeSize = entry.size || currentSize;
    beforeTotal += beforeSize;

    avifSizes = entry.variants.avif.map(function (v) {
      return fs.statSync(path.join(ROOT, v.file)).size;
    });
    webpSizes = entry.variants.webp.map(function (v) {
      return fs.statSync(path.join(ROOT, v.file)).size;
    });
    avifSmallestTotal += Math.min.apply(null, avifSizes);
    avifFullTotal += avifSizes[avifSizes.length - 1];
    webpSmallestTotal += Math.min.apply(null, webpSizes);

    console.log(
      filename +
        ": " +
        Math.round(beforeSize / 1024) +
        "KB jpg -> " +
        "avif[" +
        entry.variants.avif
          .map(function (v, idx) {
            return v.width + "w " + Math.round(avifSizes[idx] / 1024) + "KB";
          })
          .join(", ") +
        "] " +
        "webp[" +
        entry.variants.webp
          .map(function (v, idx) {
            return v.width + "w " + Math.round(webpSizes[idx] / 1024) + "KB";
          })
          .join(", ") +
        "]"
    );
  }

  writeManifest(manifest);

  console.log("");
  console.log("wrote assets/js/image-manifest.js (" + files.length + " photos)");
  console.log(
    "A browser only ever downloads ONE variant per image (whichever format+\n" +
      "size its <picture> pick lands on), never all of them -- so the real\n" +
      "comparison is against the single original JPG each replaces:"
  );
  console.log(
    "  Phones, AVIF-capable (~96%+ of traffic in 2026): " +
      Math.round(beforeTotal / 1024) +
      "KB -> " +
      Math.round(avifSmallestTotal / 1024) +
      "KB (" +
      Math.round((1 - avifSmallestTotal / beforeTotal) * 100) +
      "% smaller)"
  );
  console.log(
    "  Desktop, AVIF-capable, full size:                 " +
      Math.round(beforeTotal / 1024) +
      "KB -> " +
      Math.round(avifFullTotal / 1024) +
      "KB (" +
      Math.round((1 - avifFullTotal / beforeTotal) * 100) +
      "% smaller)"
  );
  console.log(
    "  Phones, WebP fallback (no AVIF support):          " +
      Math.round(beforeTotal / 1024) +
      "KB -> " +
      Math.round(webpSmallestTotal / 1024) +
      "KB (" +
      Math.round((1 - webpSmallestTotal / beforeTotal) * 100) +
      "% smaller)"
  );
}

if (require.main === module) {
  run().catch(function (err) {
    console.error(err);
    process.exit(1);
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    shouldSkip,
    optimizeOne,
    writeManifest,
    loadExistingManifest,
    run
  };
}
