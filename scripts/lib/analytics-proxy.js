/**
 * @fileoverview The first-party paths the analytics tracker is served from and
 * sends to. ONE definition, required by both build scripts.
 *
 * WHY A PROXY AT ALL
 * List-based content blockers (uBlock Origin's EasyPrivacy, Brave, most DNS
 * filters, and the owner's own router) match on HOSTNAME. `cloud.umami.is` and
 * `gateway.umami.is` are both on those lists, so for a blocked visitor the
 * script never loads and nothing is ever counted. Serving both through our own
 * origin is Umami's documented workaround: the browser only ever talks to
 * yallternativeliving.com, which no list can block without blocking the shop.
 *
 * WHY THESE PATH NAMES
 * A first-party proxy at `/analytics/...` or `/umami/...` is defeated by the
 * same lists a day later, because the generic path rules catch it. The names
 * below are deliberately unremarkable and specific to this shop -- no filter
 * list will ever ship a rule for `/porch-light/`. They contain none of the
 * words the blockers' generic rules key on (analytics, umami, stats, track,
 * collect, metrics, pixel, beacon).
 *
 * WHY `/api/send` IS PART OF IT AND NOT NEGOTIABLE
 * The tracker builds its collection URL by string concatenation:
 *   `${(data-host-url || "https://gateway.umami.is").replace(/\/$/, "")}/api/send`
 * (read verbatim out of the live cloud.umami.is/script.js, 2026-09-02). The
 * `/api/send` suffix is hardcoded, so the only thing we choose is the prefix.
 * `POST /porch-light/api/send` is about as unremarkable as a request gets.
 *
 * NOTE THE COLLISION THAT IS *NOT* HAPPENING: `/porch-light/api/send` is a
 * different path from the Cloudflare Worker's `/api/*` proxy. Analytics does
 * not touch the money path, does not consume the Worker's request budget, and
 * a broken analytics rule cannot take checkout down.
 *
 * ANALYTICS_HOST_URL is RELATIVE on purpose. An absolute
 * "https://yallternativeliving.com" would make every send from
 * www.yallternativeliving.com a cross-origin request, which `connect-src
 * 'self'` refuses -- the exact class of bug that made this site's analytics
 * record nothing for its first weeks. A relative value is resolved by fetch()
 * against whichever host the visitor actually loaded, so both spellings work.
 */

/** The one path prefix. Everything below is derived from it. */
const ANALYTICS_PROXY_PREFIX = "/porch-light";

/** `<script src>` on every page. Rewritten (200) to UMAMI_SCRIPT_URL. */
const ANALYTICS_SCRIPT_PATH = ANALYTICS_PROXY_PREFIX + "/script.js";

/** `data-host-url` on the tag. Relative -- see the file comment. */
const ANALYTICS_HOST_URL = ANALYTICS_PROXY_PREFIX;

/** Where the tracker therefore POSTs. Rewritten (200) to UMAMI_SEND_URL. */
const ANALYTICS_SEND_PATH = ANALYTICS_HOST_URL + "/api/send";

/** Umami Cloud's real origins. Only the proxy rules may name these. */
const UMAMI_SCRIPT_URL = "https://cloud.umami.is/script.js";
const UMAMI_SEND_URL = "https://gateway.umami.is/api/send";

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
  ANALYTICS_PROXY_PREFIX,
  ANALYTICS_SCRIPT_PATH,
  ANALYTICS_HOST_URL,
  ANALYTICS_SEND_PATH,
  UMAMI_SCRIPT_URL,
  UMAMI_SEND_URL,
  BLOCKLIST_BAIT_WORDS
};
