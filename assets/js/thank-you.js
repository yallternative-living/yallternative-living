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
   Both are best-effort and never block rendering the "thanks!" page even
   if something above fails or these globals aren't ready yet.
   ========================================================== */
(function () {
  "use strict";
  try {
    var params = new URLSearchParams(window.location.search);
    var amount = parseFloat(params.get("amount"));
    var currency = (params.get("currency") || "usd").toUpperCase();

    if (!isNaN(amount) && typeof window.plausible === "function") {
      window.plausible("Purchase", {
        props: {
          revenue: {
            currency: currency,
            amount: amount
          }
        }
      });
    }

    if (window.YLCart && typeof window.YLCart.clear === "function") {
      window.YLCart.clear();
    }

    var amountEl = document.getElementById("thankYouAmount");
    if (amountEl && !isNaN(amount)) {
      amountEl.textContent = "$" + amount.toFixed(2);
      amountEl.hidden = false;
    }
  } catch {
    /* Never let a query-param hiccup break this page's "thanks!" message. */
  }
})();
