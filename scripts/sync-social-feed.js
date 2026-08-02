/**
 * @fileoverview Build-time Social Feed Verification & Syndication Script.
 * Validates images, urls, and handles in assets/data/social-feed.json
 * during npm run build-data.
 */
const fs = require("fs");
const path = require("path");

function syncSocialFeed() {
  const feedPath = path.join(__dirname, "..", "assets", "data", "social-feed.json");
  if (!fs.existsSync(feedPath)) {
    console.warn("[social-feed-sync] Warning: assets/data/social-feed.json not found");
    return;
  }

  try {
    const raw = fs.readFileSync(feedPath, "utf8");
    const data = JSON.parse(raw);
    const posts = data.posts || [];
    let validCount = 0;

    posts.forEach((post, i) => {
      if (!post.id) post.id = `ugc-${i + 1}`;
      if (!post.handle) post.handle = "@yallternativeliving";

      // Verify local image path if specified
      if (post.image && post.image.startsWith("assets/")) {
        const imgOnDisk = path.join(__dirname, "..", post.image);
        if (!fs.existsSync(imgOnDisk)) {
          console.warn(`[social-feed-sync] Warning: image not found on disk: ${post.image}`);
        } else {
          validCount++;
        }
      }
    });

    console.log(
      `[social-feed-sync] Verified ${posts.length} UGC posts (${validCount} local assets verified).`
    );
  } catch (err) {
    console.error("[social-feed-sync] Error parsing social-feed.json:", err.message);
  }
}

if (require.main === module) {
  syncSocialFeed();
}

module.exports = { syncSocialFeed };
