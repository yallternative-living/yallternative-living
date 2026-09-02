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

    /* No invented total. The receipt block stays hidden unless the redirect
       actually carried a usable amount -- the old hardcoded placeholder total
       was printed for every order whose amount was missing, which read as a
       real charge the shopper never made. */
    var amountGroup = document.getElementById("thankYouAmountGroup");
    var amountDisplay = document.getElementById("thankYouAmountDisplay");
    /* ...and only for a real checkout redirect: a hand-typed
       ?session_id=hello&amount=5 used to print "$5.00" under "Verified
       Stripe Payment". */
    if (hasAmount && isValidSession) {
      if (amountDisplay) amountDisplay.textContent = "$" + amount.toFixed(2);
      if (amountGroup) amountGroup.hidden = false;
    } else {
      if (amountDisplay) amountDisplay.textContent = "";
      if (amountGroup) amountGroup.hidden = true;
    }

    /* No valid session id means this is not a checkout redirect -- a
       bookmark, a shared link, a typed URL, or a Stripe redirect that lost
       its query string. The page used to greet all of those with "Order
       Confirmed · Receipt Issued", a "Payment Received" pill, today's date
       and an empty Order Reference row with a Copy button, i.e. a receipt
       for an order that does not exist. Say what is actually true instead
       and leave the lookup and shop links, which are the useful part. */
    if (!isValidSession) {
      var eyebrowEl = document.getElementById("thankYouEyebrow");
      var titleEl = document.getElementById("thankYouTitle");
      var ledeEl = document.getElementById("thankYouLede");
      var cardEl = document.getElementById("thankYouCard");
      var badgeWrapEl = document.getElementById("thankYouBadgeWrap");
      if (eyebrowEl) eyebrowEl.textContent = "Order Confirmation";
      if (titleEl) titleEl.textContent = "No order to show here";
      if (ledeEl) {
        ledeEl.textContent =
          "This page fills in right after a checkout finishes. If you just placed an order, " +
          "your receipt is in the confirmation email from Stripe \u2014 and you can look the " +
          "order up below with the reference from that email.";
      }
      if (cardEl) cardEl.hidden = true;
      if (badgeWrapEl) badgeWrapEl.hidden = true;
    }

    var sessionRow = document.getElementById("thankYouSessionRow");
    var sessionCode = document.getElementById("thankYouSessionCode");
    if (isValidSession && sessionRow && sessionCode) {
      sessionCode.textContent = sessionId;
      sessionRow.hidden = false;

      /* The `amount` in the URL was computed when the Worker CREATED the
         session -- before Stripe applied any promotion code typed on the
         Stripe page -- so it can be higher than what was actually charged.
         Ask the Worker for the settled figures and, if they arrive, replace
         the hint. Best-effort: on any failure the hint stays as it was. The
         route only answers for a paid, complete session, and this side
         checks the same thing again so a partial or unexpected payload can
         never put a "verified" total on screen for money that was not
         taken. */
      if (typeof fetch === "function") {
        try {
          fetch("/api/order-summary", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: sessionId })
          })
            .then(function (res) {
              return res.ok ? res.json() : null;
            })
            .then(function (summary) {
              if (!summary || summary.found !== true) return;
              var paid =
                summary.paymentStatus === "paid" || summary.paymentStatus === "no_payment_required";
              if (!paid || summary.status !== "complete") return;
              if (typeof summary.amountTotalCents !== "number") return;
              if (!isFinite(summary.amountTotalCents) || summary.amountTotalCents < 0) return;

              if (amountDisplay) {
                amountDisplay.textContent = "$" + (summary.amountTotalCents / 100).toFixed(2);
              }
              if (amountGroup) amountGroup.hidden = false;

              /* Stripe folds a redeemed gift card into the same discount
                 figure as a promo code (the Worker applies gift cards as a
                 single-use coupon), so split the two and name each honestly:
                 a shopper who paid with a gift card did not use a "coupon". */
              var discountCents = Number(summary.amountDiscountCents) || 0;
              var giftCents = Number(summary.giftCardAppliedCents) || 0;
              if (giftCents > discountCents) giftCents = discountCents;
              var promoCents = discountCents - giftCents;

              function note(id, text) {
                if (!amountGroup) return;
                var el = document.getElementById(id);
                if (!el) {
                  el = document.createElement("span");
                  el.id = id;
                  el.className = "receipt-discount-note";
                  amountGroup.appendChild(el);
                }
                el.textContent = text;
                el.hidden = false;
              }
              if (giftCents > 0) {
                note(
                  "thankYouGiftCardNote",
                  "Gift card applied: -$" + (giftCents / 100).toFixed(2)
                );
              }
              if (promoCents > 0) {
                note(
                  "thankYouDiscountNote",
                  "Promo code applied: -$" + (promoCents / 100).toFixed(2)
                );
              }
            })
            .catch(function () {});
        } catch {
          /* Fallback remains the initial URL amount hint */
        }
      }

      // Copy reference button
      var copyBtn = document.getElementById("copyRefBtn");
      if (copyBtn) {
        var copyStatus = document.getElementById("copyRefStatus");
        var copyText = copyBtn.querySelector(".copy-text");
        var copyResetTimer = null;
        function showCopyResult(label, announcement) {
          if (copyText) {
            copyText.textContent = label;
            clearTimeout(copyResetTimer);
            copyResetTimer = setTimeout(function () {
              copyText.textContent = "Copy";
            }, 2500);
          }
          /* The visible label is inside a button whose aria-label never
             changes, so a screen reader hears nothing from it; announce the
             result through a live region instead. */
          if (copyStatus) copyStatus.textContent = announcement;
        }
        function selectReferenceText() {
          /* No clipboard API (plain http, an old webview, a denied
             permission): select the reference so one long-press or Ctrl+C
             copies it, and say so. Silence here used to look like a dead
             button. */
          try {
            var range = document.createRange();
            range.selectNodeContents(sessionCode);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          } catch {
            /* selection API unavailable: the text is still on screen */
          }
          showCopyResult(
            "Select & copy",
            "Copying is not available here. The order reference is selected; copy it by hand."
          );
        }
        copyBtn.addEventListener("click", function () {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            navigator.clipboard
              .writeText(sessionId)
              .then(function () {
                showCopyResult("Copied!", "Order reference copied to the clipboard.");
              })
              .catch(selectReferenceText);
          } else {
            selectReferenceText();
          }
        });
      }

      /* Pre-fill the reference when the lookup opens, and put the cursor
         in the email field. It used to auto-submit here too, but the lookup
         needs the checkout email as well and that is never known on this
         page, so every click on the primary button opened straight into a
         red "Enter the email you used at checkout." The shopper types one
         thing and presses one button; that is the whole flow. */
      var trackBtn = document.getElementById("openOrderStatusBtn");
      if (trackBtn) {
        trackBtn.addEventListener("click", function () {
          setTimeout(function () {
            var orderInput = document.getElementById("order-id-input");
            var emailInput = document.getElementById("order-email-input");
            if (orderInput && sessionId) orderInput.value = sessionId;
            if (emailInput) emailInput.focus();
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
