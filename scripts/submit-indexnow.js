#!/usr/bin/env node
/**
 * @fileoverview Submits all URLs in sitemap.xml to the IndexNow protocol
 * endpoint (https://api.indexnow.org/indexnow) so Bing, Microsoft Copilot,
 * ChatGPT Search, DuckDuckGo, Yandex, Naver, and Seznam immediately index
 * updated pages without waiting for a scheduled crawl.
 *
 * Reference: https://www.indexnow.org/documentation
 *
 * Usage:
 *   npm run indexnow
 *   node scripts/submit-indexnow.js --dry-run
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_KEY = "8a4e9f2c6b1d7035e4a8c9f01234b567";
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/**
 * Extracts all `<loc>` URLs from a sitemap.xml string.
 * @param {string} xml Raw XML content of sitemap.xml.
 * @return {!Array<string>} Array of canonical URLs.
 */
function parseSitemapUrls(xml) {
  const urls = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

/**
 * Builds the IndexNow JSON request body per the IndexNow specification.
 * @param {string} host Domain host (e.g., "yallternativeliving.com").
 * @param {string} key 8-128 character hexadecimal/alphanumeric IndexNow key.
 * @param {!Array<string>} urlList Array of full URLs belonging to host.
 * @return {{host: string, key: string, keyLocation: string, urlList: !Array<string>}}
 */
function buildIndexNowPayload(host, key, urlList) {
  if (!/^[A-Za-z0-9-]{8,128}$/.test(key)) {
    throw new Error("Invalid IndexNow key format: must be 8-128 chars of [A-Za-z0-9-]");
  }
  if (!Array.isArray(urlList) || urlList.length === 0) {
    throw new Error("IndexNow urlList must contain at least one URL");
  }
  return {
    host: host,
    key: key,
    keyLocation: "https://" + host + "/" + key + ".txt",
    urlList: urlList
  };
}

/**
 * Runs the IndexNow submission from CLI arguments.
 * @return {!Promise<void>}
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const sitemapPath = path.join(ROOT, "sitemap.xml");
  if (!fs.existsSync(sitemapPath)) {
    throw new Error("sitemap.xml not found at " + sitemapPath);
  }
  const keyPath = path.join(ROOT, DEFAULT_KEY + ".txt");
  if (!fs.existsSync(keyPath)) {
    throw new Error("IndexNow key file not found at " + keyPath + " (run npm run build-data)");
  }

  const key = fs.readFileSync(keyPath, "utf8").trim();
  const xml = fs.readFileSync(sitemapPath, "utf8");
  const urlList = parseSitemapUrls(xml);
  if (urlList.length === 0) {
    throw new Error("No <loc> URLs found in sitemap.xml");
  }

  const firstHost = new URL(urlList[0]).hostname;
  const payload = buildIndexNowPayload(firstHost, key, urlList);

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("[IndexNow] Verifying live key file at " + payload.keyLocation + " ...");
  const keyResp = await fetch(payload.keyLocation, {
    headers: { "Cache-Control": "no-cache" }
  });
  if (!keyResp.ok) {
    throw new Error(
      "Live key file returned HTTP " +
        keyResp.status +
        " at " +
        payload.keyLocation +
        " -- wait for the deploy to finish before running npm run indexnow."
    );
  }
  const liveKey = (await keyResp.text()).trim();
  if (liveKey !== key) {
    throw new Error(
      "Live key file content mismatch at " +
        payload.keyLocation +
        " (got " +
        JSON.stringify(liveKey.slice(0, 40)) +
        ")"
    );
  }
  console.log("[IndexNow] Live key verified (" + key + ").");

  console.log(
    "[IndexNow] Submitting " +
      urlList.length +
      " URLs for " +
      firstHost +
      " to " +
      INDEXNOW_ENDPOINT +
      " ..."
  );
  const response = await fetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(payload)
  });

  const bodyText = await response.text();
  if (response.status === 200 || response.status === 202) {
    console.log(
      "[IndexNow] Success (HTTP " +
        response.status +
        "): " +
        urlList.length +
        " URLs broadcast to IndexNow engines."
    );
    return;
  }

  throw new Error(
    "[IndexNow] Submission failed with HTTP " + response.status + ": " + bodyText.slice(0, 300)
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_KEY,
  INDEXNOW_ENDPOINT,
  parseSitemapUrls,
  buildIndexNowPayload
};
