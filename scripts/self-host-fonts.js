/**
 * @fileoverview One-time helper: download the site's web fonts (Gloock +
 * DM Sans) as WOFF2 into assets/fonts/ so they can be self-hosted instead of
 * loaded from Google Fonts. Run locally (needs internet):
 *
 *     node scripts/self-host-fonts.js
 *
 * Why self-host: removes a third-party origin (fonts.googleapis.com /
 * fonts.gstatic.com) from the critical path and the CSP, kills the extra
 * DNS+TLS handshake, and lets you pin exact files. After running this, follow
 * docs/SELF-HOSTING-FONTS.md to flip the CSS + <head> links + CSP over.
 *
 * No dependencies — uses Node's built-in https + the open google-webfonts-helper
 * API (https://gwfh.mranftl.com) to resolve the current WOFF2 URLs.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const OUT_DIR = path.join(__dirname, "..", "assets", "fonts");

// family slug -> variant ids to pull (gwfh uses "regular" for 400)
const FONTS = {
  gloock: ["regular"],
  "dm-sans": ["regular", "500", "700"]
};

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "yallternative-living" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("Status " + res.statusCode));
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
      })
      .on("error", (err) => {
        fs.unlink(dest, () => reject(err));
      });
  });
}

if (require.main === module) {
  (async () => {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

    for (const [family, wantIds] of Object.entries(FONTS)) {
      const meta = await getJson(`https://gwfh.mranftl.com/api/fonts/${family}?subsets=latin`);
      for (const id of wantIds) {
        const variant = (meta.variants || []).find((v) => v.id === id);
        if (!variant || !variant.woff2) {
          console.warn(`  ! ${family} ${id}: no woff2 found, skipping`);
          continue;
        }
        const weight = id === "regular" ? "400" : id;
        const filename = `${family}-${weight}.woff2`;
        const dest = path.join(OUT_DIR, filename);
        await download(variant.woff2, dest);
        console.log(`  ✓ ${filename}`);
      }
    }

    console.log(
      "\nDone. Fonts are in assets/fonts/. Next: follow docs/SELF-HOSTING-FONTS.md\n" +
        "to swap the <head> font links for @font-face, and update the CSP."
    );
  })().catch((err) => {
    console.error("Font download failed:", err.message);
    console.error(
      "If the google-webfonts-helper API is unreachable, you can also grab the\n" +
        "WOFF2 files by hand from https://gwfh.mranftl.com and drop them in assets/fonts/."
    );
    process.exit(1);
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getJson, download };
}
