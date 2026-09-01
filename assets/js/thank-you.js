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
    var amount = parseFloat(params.get("amount"));
    var currency = (params.get("currency") || "usd").toUpperCase();
    var isFreshOrder = claimSession((params.get("session_id") || "").trim());

    if (isFreshOrder && !isNaN(amount) && typeof window.plausible === "function") {
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
    if (amountEl && !isNaN(amount)) {
      amountEl.textContent = "$" + amount.toFixed(2);
      amountEl.hidden = false;
    }

    var amountDisplay = document.getElementById("thankYouAmountDisplay");
    if (amountDisplay) {
      if (!isNaN(amount)) {
        amountDisplay.textContent = "$" + amount.toFixed(2);
      } else {
        amountDisplay.textContent = "$25.00";
      }
    }

    var sessionId = (params.get("session_id") || "").trim();
    var sessionRow = document.getElementById("thankYouSessionRow");
    var sessionCode = document.getElementById("thankYouSessionCode");
    if (sessionId && sessionRow && sessionCode) {
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

    /* ---------- R3: Digital Gift Certificate Parser & Controller ---------- */
    var giftCode = (
      params.get("gift_code") ||
      params.get("code") ||
      params.get("gift_card_code") ||
      ""
    ).trim();
    var recipient = (params.get("recipient") || params.get("to") || "").trim();
    var sender = (params.get("sender") || params.get("from") || "").trim();
    var customNote = (
      params.get("message") ||
      params.get("note") ||
      params.get("gift_message") ||
      ""
    ).trim();

    var certSection = document.getElementById("giftCertificateSection");
    if (giftCode && certSection) {
      certSection.hidden = false;

      var certCodeEl = document.getElementById("giftCertCode");
      if (certCodeEl) {
        certCodeEl.textContent = giftCode;
      }

      var certValEl = document.getElementById("giftCertValue");
      if (certValEl && !isNaN(amount)) {
        certValEl.textContent = "$" + amount.toFixed(2);
      }

      var certRecipientEl = document.getElementById("giftCertRecipient");
      if (certRecipientEl && recipient) {
        certRecipientEl.textContent = recipient;
      }

      var certSenderEl = document.getElementById("giftCertSender");
      if (certSenderEl && sender) {
        certSenderEl.textContent = sender;
      }

      var certMessageEl = document.getElementById("giftCertMessage");
      if (certMessageEl && customNote) {
        certMessageEl.textContent = customNote;
      }

      var printBtn = document.getElementById("printGiftCertBtn");
      if (printBtn) {
        printBtn.addEventListener("click", function () {
          window.print();
        });
      }

      var copyBtn = document.getElementById("copyGiftCertCodeBtn");
      var feedbackEl = document.getElementById("giftCertCopyFeedback");
      if (copyBtn) {
        copyBtn.addEventListener("click", function () {
          var originalText = copyBtn.innerHTML;
          function showSuccess() {
            copyBtn.innerHTML =
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!';
            if (feedbackEl) {
              feedbackEl.textContent = "Gift card code " + giftCode + " copied to clipboard.";
            }
            setTimeout(function () {
              copyBtn.innerHTML = originalText;
            }, 2500);
          }

          if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            navigator.clipboard
              .writeText(giftCode)
              .then(showSuccess)
              .catch(function () {
                fallbackCopy();
              });
          } else {
            fallbackCopy();
          }

          function fallbackCopy() {
            try {
              var tempInput = document.createElement("input");
              tempInput.value = giftCode;
              document.body.appendChild(tempInput);
              tempInput.select();
              document.execCommand("copy");
              document.body.removeChild(tempInput);
              showSuccess();
            } catch {
              if (feedbackEl) {
                feedbackEl.textContent = "Could not copy code. Please copy manually: " + giftCode;
              }
            }
          }
        });
      }
    }
  } catch {
    /* Never let a query-param hiccup break this page's "thanks!" message. */
  }
})();
