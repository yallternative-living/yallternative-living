/* ==========================================================
   Y'ALLTERNATIVE LIVING | analytics loader
   ==========================================================

   WHAT THIS IS
   The page no longer carries the analytics tracker tag directly. It carries a
   tag pointing HERE, with the same data-* attributes, and this file decides
   which of two copies of the tracker to inject. Exactly one is ever loaded.

     1. DIRECT, first:  https://cloud.umami.is/script.js, with NO
        data-host-url, so it posts straight to gateway.umami.is.
     2. FIRST-PARTY, only if the direct copy fails:
        /porch-light/script.js with data-host-url="/porch-light", proxied to
        Umami by the status=200 rules in netlify.toml / vercel.json.

   WHY BOTH, INSTEAD OF JUST THE PROXY
   The proxy defeats hostname-matching blockers, which is worth having: without
   it, a blocked visitor produces no rows at all. But it is not free. Umami
   builds its session id from the IP of whatever opened the connection, and
   geolocates the same address -- which through a Netlify proxy is Netlify's
   edge, not the shopper (src/lib/ip.ts ranks cf-connecting-ip above
   x-nf-client-connection-ip, and Cloudflare sets cf-connecting-ip to its own
   peer; confirmed empirically on 2026-09-02, when a send carrying
   payload.ip=1.1.1.1 was still recorded against the CONNECTING request's
   country). So proxying everybody would have traded correct visitor counts and
   correct geography, for everybody, to recover the blocked minority.

   Direct-first pays that cost only for the visitors who would otherwise not be
   counted at all. Everyone else is measured exactly as before this file
   existed. See docs/ANALYTICS.md §0 and §7.

   HOW THE FALLBACK IS DETECTED
   A <script> element fires `error` when the request is refused OR fails to
   resolve. Both of the cases that matter here do that: a content blocker
   cancels the request, and a filtering DNS resolver fails it. Neither produces
   a `load`, so one `error` handler covers both without a timer.

   WHY IT IS AN EXTERNAL FILE
   Every inline script on this site is pinned by a CSP hash
   (scripts/inline-script-hashes.json). An inline loader would mean a hash
   baseline update on every page for every edit to this logic. External costs
   one cached request and keeps the baseline untouched.

   WHAT IT DOES NOT DO
   It does not implement any tracking of its own, it never sends anything, and
   it does not touch the payload. Scrubbing, the prerender rule and the event
   buffer all live in assets/js/main.js (window.ylAnalyticsBeforeSend), named
   by data-before-send, and work identically for whichever copy lands --
   Umami resolves that name on window at send time, and main.js's buffer polls
   for window.umami rather than assuming it is already there.
   ========================================================== */
(function () {
  "use strict";

  /* The tag that loaded this file: it carries every attribute the tracker
     needs. Read it synchronously -- document.currentScript is only correct
     while this script is executing. */
  var loaderTag = typeof document !== "undefined" ? document.currentScript : null;
  if (!loaderTag || typeof document.createElement !== "function") return;

  var DIRECT_SRC = "https://cloud.umami.is/script.js";
  var FALLBACK_SRC = "/porch-light/script.js";
  var FALLBACK_HOST_URL = "/porch-light";
  /* Marks the sessions that came through the proxy, so the two populations can
     be told apart in the dashboard: Sessions -> filter by tag. Without it there
     is no way to know which visitors are the ones whose country and session id
     are the proxy's rather than their own. Set on the fallback copy ONLY. */
  var FALLBACK_TAG = "fallback";

  var websiteId = loaderTag.getAttribute("data-website-id");
  if (!websiteId) return;

  /* The hostname allow-list, enforced HERE as well as by the tracker itself.
     Umami's own data-domains check disables the tracker after it has loaded;
     checking first means localhost, the Puppeteer suites' 127.0.0.1 port and
     Netlify's *.netlify.app previews never even request it. Belt and braces on
     the one thing that keeps test runs out of the production dataset -- the
     attribute is copied onto the injected tag too. */
  var domains = (loaderTag.getAttribute("data-domains") || "")
    .split(",")
    .map(function (d) {
      return d.trim();
    })
    .filter(Boolean);
  if (domains.length) {
    var host = "";
    try {
      host = window.location.hostname;
    } catch {
      return;
    }
    if (domains.indexOf(host) === -1) return;
  }

  /* Every data-* attribute from the loader tag, copied verbatim. Copying
     rather than listing means a new attribute added in build-site-data.js
     reaches the tracker without an edit here -- and cannot be silently
     dropped by this file. */
  function copyDataAttributes(target) {
    var attrs = loaderTag.attributes;
    for (var i = 0; i < attrs.length; i++) {
      var name = attrs[i].name;
      if (name.indexOf("data-") === 0) target.setAttribute(name, attrs[i].value);
    }
  }

  /* Exactly one copy, ever. `settled` is set before the element is inserted,
     so even a synchronous error cannot start a third attempt. */
  var settled = false;

  function injectFallback() {
    if (settled) return;
    settled = true;
    var tag = document.createElement("script");
    copyDataAttributes(tag);
    tag.setAttribute("data-host-url", FALLBACK_HOST_URL);
    tag.setAttribute("data-tag", FALLBACK_TAG);
    tag.src = FALLBACK_SRC;
    tag.defer = true;
    /* No error handler on this one on purpose. If the first-party path fails
       too, the visitor is offline or the proxy rule is broken, and there is no
       third thing to try -- main.js's event buffer gives up on its own and
       drops what it is holding. */
    (document.head || document.documentElement).appendChild(tag);
  }

  function injectDirect() {
    var tag = document.createElement("script");
    copyDataAttributes(tag);
    /* NO data-host-url: the tracker then posts to its own default,
       gateway.umami.is, straight from the visitor's browser -- which is the
       whole point. Their real IP reaches Umami, so the session id and the
       country are theirs. */
    tag.src = DIRECT_SRC;
    tag.defer = true;
    tag.addEventListener("error", function () {
      /* Blocked, or unresolvable. Both fire error and neither fires load. */
      injectFallback();
    });
    tag.addEventListener("load", function () {
      settled = true;
    });
    (document.head || document.documentElement).appendChild(tag);
  }

  injectDirect();
})();
