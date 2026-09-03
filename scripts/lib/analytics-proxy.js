/**
 * @fileoverview The analytics loader and the first-party fallback paths.
 * ONE definition, required by both build scripts, qa-check and the tests.
 *
 * THE SHAPE, SINCE 2026-09-02
 * The page carries a tag pointing at ANALYTICS_LOADER_PATH -- an ordinary file
 * of ours -- with the tracker's data-* attributes on it. That loader
 * (assets/js/porch-light.js) injects exactly one of two copies of the tracker:
 *
 *   1. DIRECT first: UMAMI_SCRIPT_URL, with no data-host-url, so the browser
 *      posts to UMAMI_SEND_URL itself. The visitor's real IP reaches Umami, so
 *      their session id and their country are their own.
 *   2. FIRST-PARTY only on the direct copy's `error` event: ANALYTICS_SCRIPT_PATH
 *      with data-host-url = ANALYTICS_HOST_URL, which the status=200 rewrite
 *      rules in netlify.toml / vercel.json proxy through to Umami.
 *
 * WHY BOTH
 * List-based blockers match HOSTNAMES, and both Umami hosts are on those lists
 * (the shop owner's own router blocks them at DNS), so route 1 alone counts
 * nothing for a blocked visitor. But route 2 is not free: Umami derives the
 * session id AND the geography from whatever IP opened the connection, which
 * through a Netlify proxy is Netlify's edge. Confirmed empirically on
 * 2026-09-02 -- a send carrying payload.ip=1.1.1.1 was still recorded against
 * the connecting request's country, so no relay of ours could fix it either.
 *
 * Direct-first pays route 2's cost only for the visitors who would otherwise be
 * invisible. Everyone else is measured exactly as they were. Sessions that came
 * the long way are marked with data-tag=FALLBACK_TAG so the two populations can
 * be told apart in the dashboard. See docs/ANALYTICS.md §7.
 *
 * WHY THESE PATH NAMES
 * A first-party proxy at `/analytics/…` or `/umami/…` is caught by the same
 * lists' generic path rules a release later. The names below carry none of the
 * words those rules key on and are specific enough to this shop that no list
 * will ship a rule for them.
 *
 * WHY `/api/send` IS PART OF IT AND NOT NEGOTIABLE
 * The tracker builds its collection URL by string concatenation:
 *   `${(data-host-url || "https://gateway.umami.is").replace(/\/$/, "")}/api/send`
 * (read verbatim out of the live cloud.umami.is/script.js, 2026-09-02). The
 * `/api/send` suffix is hardcoded; the only thing we choose is the prefix.
 *
 * NOTE THE COLLISION THAT IS *NOT* HAPPENING: `/porch-light/api/send` is a
 * different path from the Cloudflare Worker's `/api/*` proxy. Analytics does
 * not touch the money path and cannot consume the Worker's request budget.
 *
 * ANALYTICS_HOST_URL is RELATIVE on purpose. An absolute
 * "https://yallternativeliving.com" would make every send from
 * www.yallternativeliving.com a cross-origin request, which `connect-src
 * 'self'` refuses -- the exact class of bug that made this site's analytics
 * record nothing for its first weeks. A relative value is resolved by fetch()
 * against whichever host the visitor actually loaded, so both spellings work.
 */

/** Our own file, the only analytics script the page itself references. */
const ANALYTICS_LOADER_PATH = "/assets/js/porch-light.js";

/** The one path prefix the fallback route lives under. */
const ANALYTICS_PROXY_PREFIX = "/porch-light";

/** Route 2's `<script src>`. Rewritten (200) to UMAMI_SCRIPT_URL. */
const ANALYTICS_SCRIPT_PATH = ANALYTICS_PROXY_PREFIX + "/script.js";

/** Route 2's `data-host-url`. Relative -- see the file comment. */
const ANALYTICS_HOST_URL = ANALYTICS_PROXY_PREFIX;

/** Where route 2 therefore POSTs. Rewritten (200) to UMAMI_SEND_URL. */
const ANALYTICS_SEND_PATH = ANALYTICS_HOST_URL + "/api/send";

/** Umami Cloud's real origins. Route 1 uses them from the browser; the proxy
    rules use them server-side; the CSP has to allow both. */
const UMAMI_SCRIPT_ORIGIN = "https://cloud.umami.is";
const UMAMI_SEND_ORIGIN = "https://gateway.umami.is";
const UMAMI_SCRIPT_URL = UMAMI_SCRIPT_ORIGIN + "/script.js";
const UMAMI_SEND_URL = UMAMI_SEND_ORIGIN + "/api/send";

/** data-tag on the fallback copy only, so the Sessions view can separate the
    visitors whose country and session id are the proxy's from everyone else. */
const FALLBACK_TAG = "fallback";

/**
 * Words a blocker's generic path rules key on. The paths above must contain
 * none of them; scripts/analytics.test.js asserts it rather than trusting the
 * next person who renames the prefix.
 */
const BLOCKLIST_BAIT_WORDS = [
  "analytics",
  "umami",
  "stats",
  "track",
  "collect",
  "metrics",
  "pixel",
  "beacon"
];

module.exports = {
  ANALYTICS_LOADER_PATH,
  ANALYTICS_PROXY_PREFIX,
  ANALYTICS_SCRIPT_PATH,
  ANALYTICS_HOST_URL,
  ANALYTICS_SEND_PATH,
  UMAMI_SCRIPT_ORIGIN,
  UMAMI_SEND_ORIGIN,
  UMAMI_SCRIPT_URL,
  UMAMI_SEND_URL,
  FALLBACK_TAG,
  BLOCKLIST_BAIT_WORDS
};
