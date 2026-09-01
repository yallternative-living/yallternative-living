/* ==========================================================
   Y'ALLTERNATIVE LIVING | thank-you.html page logic
   Loaded `defer`, after main.js and cart.js (both also deferred, so
   document-order defer execution guarantees window.plausible and
   window.YLCart already exist by the time this runs).

   This page is the Stripe Checkout success_url target (see
   workers/checkout.js). Two things happen here:
     1. Fire a best-effort "Purchase" analytics event using the amount/
        currency the Worker embedded in the redirect URL at the moment it
        created the Stripe session (see docs/STRIPE-MIGRATION.md step 6 --
        this is ONLY for analytics, never proof of payment).
     2. Clear the local cart, since the order that was in it just went
        through.
   Both are once per order, keyed off the redirect's session_id (see
   claimSession below), and both are best-effort: neither ever blocks
   rendering the "thanks!" page if something above fails or these globals
   aren't ready yet.
   ========================================================== */
(function () {
  "use strict";

  /* Both of those are once-per-order actions, but nothing stopped this page
     from running them again on every load of the same URL. Refreshing the
     thank-you page (or hitting Back to it after shopping on) re-fired the
     Purchase event, double-counting that order's revenue in Umami, and
     re-ran YLCart.clear(), silently emptying a cart the shopper had already
     started refilling. The Worker always appends session_id to success_url
     (see workers/checkout.js), so that id is the honest "this is a fresh
     post-checkout redirect" signal: remember the last one handled and skip
     both actions for a repeat. No session_id at all means this isn't a
     checkout redirect, so neither action belongs. */
  var SEEN_KEY = "yl-thankyou-session";

  /* ...and "a session_id is present" was too weak a signal on its own. The
     Worker's success_url always carries a real Stripe Checkout Session id
     (cs_live_… / cs_test_…, see workers/checkout.js). Anything else in that
     parameter is a hand-typed or shared URL rather than a completed order,
     and must not book revenue in analytics or empty a shopper's cart. The
     amount is held to the same standard: it is only ever an analytics hint,
     so an absent, non-numeric, negative or absurd value is treated as "no
     amount" rather than reported as an order total. */
  var SESSION_ID_RE = /^cs_(live|test)_[A-Za-z0-9]+$/;
  var MAX_ORDER_AMOUNT = 10000;

  function claimSession(sessionId) {
    if (!sessionId) return false;
    try {
      if (window.localStorage.getItem(SEEN_KEY) === sessionId) return false;
      window.localStorage.setItem(SEEN_KEY, sessionId);
    } catch {
      /* Storage blocked (private mode, locked-down webview): fall through and
         handle it, matching the pre-existing behaviour rather than dropping a
         real order's cart-clear on the floor. */
    }
    return true;
  }

  try {
    var params = new URLSearchParams(window.location.search);
    var sessionId = (params.get("session_id") || "").trim();
    var isValidSession = SESSION_ID_RE.test(sessionId);

    var rawAmount = params.get("amount");
    var amount = rawAmount === null ? NaN : parseFloat(rawAmount);
    var hasAmount = isFinite(amount) && amount >= 0 && amount <= MAX_ORDER_AMOUNT;
    var currency = (params.get("currency") || "usd").toUpperCase();

    var isFreshOrder = isValidSession && hasAmount && claimSession(sessionId);

    if (isFreshOrder && typeof window.plausible === "function") {
      window.plausible("Purchase", {
        props: {
          revenue: {
            currency: currency,
            amount: amount
          }
        }
      });
    }

    if (isFreshOrder && window.YLCart && typeof window.YLCart.clear === "function") {
      window.YLCart.clear();
    }

    var amountEl = document.getElementById("thankYouAmount");
    if (amountEl && hasAmount) {
      amountEl.textContent = "$" + amount.toFixed(2);
      amountEl.hidden = false;
    }

    /* No invented total. The receipt block stays hidden unless the redirect
       actually carried a usable amount -- the old hardcoded placeholder total
       was printed for every order whose amount was missing, which read as a
       real charge the shopper never made. */
    var amountGroup = document.getElementById("thankYouAmountGroup");
    var amountDisplay = document.getElementById("thankYouAmountDisplay");
    if (hasAmount) {
      if (amountDisplay) amountDisplay.textContent = "$" + amount.toFixed(2);
      if (amountGroup) amountGroup.hidden = false;
    } else {
      if (amountDisplay) amountDisplay.textContent = "";
      if (amountGroup) amountGroup.hidden = true;
    }

    var sessionRow = document.getElementById("thankYouSessionRow");
    var sessionCode = document.getElementById("thankYouSessionCode");
    if (isValidSession && sessionRow && sessionCode) {
      sessionCode.textContent = sessionId;
      sessionRow.hidden = false;

      // Pre-fill and wire auto-lookup when opening modal
      var trackBtn = document.getElementById("openOrderStatusBtn");
      if (trackBtn) {
        trackBtn.addEventListener("click", function () {
          setTimeout(function () {
            var orderInput = document.getElementById("order-id-input");
            var orderForm = document.getElementById("orderStatusForm");
            if (orderInput && sessionId) {
              orderInput.value = sessionId;
              if (orderForm && typeof orderForm.requestSubmit === "function") {
                orderForm.requestSubmit();
              } else if (orderForm) {
                var submitBtn = orderForm.querySelector("button[type='submit']");
                if (submitBtn) submitBtn.click();
              }
            }
          }, 100);
        });
      }
    }

    var dateEl = document.getElementById("thankYouDate");
    if (dateEl) {
      var d = new Date();
      var formattedDate = d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric"
      });
      dateEl.textContent = formattedDate;
    }

    /* The digital gift-certificate renderer that used to live here read a
       gift code, recipient, sender and note straight out of the query string
       and printed them onto a certificate. workers/checkout.js never emits
       any of those parameters -- the only success_url params are session_id,
       amount and currency -- so the whole path was unreachable for real
       orders and reachable by anyone who could hand a shopper a link: a
       code plus a recipient in the query string rendered an official-looking
       certificate for a gift card that does not exist. Gift cards are
       delivered by the fulfilment email instead (see netlify/functions), so
       the parser and its markup are gone rather than merely hidden. */
  } catch {
    /* Never let a query-param hiccup break this page's "thanks!" message. */
  }
})();
