(function () {
  "use strict";

  /* Same-origin through the Netlify proxy to the Cloudflare Worker. The
     Netlify function that used to serve this answers 410 now. */
  var BALANCE_URL = "/api/gift-card-balance";

  /* "$25" for whole dollars, "$12.34" only when there are cents -- the same
     rule as YLCart.money() and main.js formatMoney(). Kept local because
     the unit harness runs this file without the cart. */
  function money(n) {
    var cents = Math.round((Number(n) || 0) * 100);
    return cents % 100 === 0 ? "$" + cents / 100 : "$" + (cents / 100).toFixed(2);
  }

  /* Cards are issued as YALL-XXXX-XXXX-XXXX -- twelve characters over an
     A-Z2-9 alphabet with the ambiguous letters dropped. Shoppers type them in
     lowercase and paste them with the dashes eaten by their mail client, and
     an unnormalised code turns a valid card into a 404 nobody can explain.

     A body of any other length keeps its single dash instead of being
     regrouped into fours: the legacy 8-character cards (YALL-XXXXXXXX) still
     spend, and inventing dash positions for them would break a real code.

     cart.js owns the canonical copy of this (YLCart.normalizeGiftCardCode)
     and scripts/cart-engine.test.js asserts the two agree character for
     character; it is duplicated rather than borrowed so the balance checker
     still works on a page that does not load the cart. */
  function normalizeGiftCardCode(code) {
    var raw = String(code == null ? "" : code)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!raw) return "";
    if (raw.indexOf("YALL") !== 0) return raw;
    var body = raw.slice(4);
    if (!body) return raw;
    if (body.length === 12) {
      return "YALL-" + body.slice(0, 4) + "-" + body.slice(4, 8) + "-" + body.slice(8);
    }
    return "YALL-" + body;
  }

  var presetBtns = document.querySelectorAll(".preset-btn");
  var customAmountGroup = document.getElementById("customAmountGroup");
  var customGiftAmount = document.getElementById("customGiftAmount");
  var giftCardAmountDisplay = document.getElementById("giftCardAmountDisplay");
  var addGiftCardBtn = document.getElementById("addGiftCardBtn");
  var giftRecipientEmail = document.getElementById("giftRecipientEmail");
  var giftSenderName = document.getElementById("giftSenderName");
  var giftMessage = document.getElementById("giftMessage");

  // Tab switcher elements
  var tabPurchase = document.getElementById("tabPurchaseGiftCard");
  var tabCheckBalance = document.getElementById("tabCheckGiftCardBalance");
  var purchasePanel =
    document.getElementById("giftCardPurchasePanel") || document.querySelector(".gift-card-widget");
  var balancePanel = document.getElementById("giftCardBalancePanel");

  // Balance checker form & elements
  var balanceForm = document.getElementById("giftCardBalanceForm");
  var balanceInput = document.getElementById("giftCardBalanceInput");
  var balanceResult = document.getElementById("giftCardBalanceResult");
  var checkBalanceBtn = document.getElementById("checkBalanceSubmitBtn");

  // --- Tab Switcher Logic ---
  if (tabPurchase && tabCheckBalance && purchasePanel && balancePanel) {
    tabPurchase.addEventListener("click", function () {
      tabPurchase.classList.add("btn-primary", "active");
      tabPurchase.classList.remove("btn-outline");
      tabCheckBalance.classList.remove("btn-primary", "active");
      tabCheckBalance.classList.add("btn-outline");

      purchasePanel.style.display = "";
      balancePanel.style.display = "none";
    });

    tabCheckBalance.addEventListener("click", function () {
      tabCheckBalance.classList.add("btn-primary", "active");
      tabCheckBalance.classList.remove("btn-outline");
      tabPurchase.classList.remove("btn-primary", "active");
      tabPurchase.classList.add("btn-outline");

      purchasePanel.style.display = "none";
      balancePanel.style.display = "block";
      if (balanceInput) balanceInput.focus();
    });
  }

  // --- Live Balance Lookup Logic ---
  if (balanceForm && balanceInput && balanceResult) {
    balanceForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var rawCode = normalizeGiftCardCode(balanceInput.value);
      if (!rawCode) return;

      if (checkBalanceBtn) {
        checkBalanceBtn.disabled = true;
        checkBalanceBtn.textContent = "Checking...";
      }

      balanceResult.hidden = false;
      balanceResult.innerHTML =
        '<p class="muted" style="font-size: 0.9rem;">Looking up gift card balance...</p>';

      // POSTed, not GETed: a code in the query string is logged by every
      // proxy in the path, kept in browser history and sent on in Referer.
      // The Worker takes {code} as a JSON body and answers no-store.
      fetch(BALANCE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ code: rawCode })
      })
        .then(function (res) {
          // The status carries meaning the body does not (a 429 body says
          // nothing a shopper can act on), so keep them together.
          return readJson(res).then(function (data) {
            return { status: res ? res.status : 0, data: data };
          });
        })
        .then(function (out) {
          var data = out.data;
          if (checkBalanceBtn) {
            checkBalanceBtn.disabled = false;
            checkBalanceBtn.textContent = "Check Balance";
          }

          if (out.status === 429) {
            // Rate-limited, not rejected. "Not found" here would send the
            // shopper hunting for a card that is sitting in their hand.
            balanceResult.innerHTML = errorBox("Too many attempts, try again in a minute.");
          } else if (data && data.valid && data.balance > 0) {
            // Server-supplied text, interpolated into innerHTML: escape it.
            // Server-supplied text, interpolated into innerHTML: escape it.
            var formatted = escapeHtml(data.formattedBalance || money(data.balance));
            var initial = data.initialAmount
              ? " (of " + money(data.initialAmount) + " initial)"
              : "";
            /* Money a checkout in progress is holding is already out of the
               balance; say so, or the card looks short (verify-D M-5). */
            var pendingCents = Number(data.pendingCents) || 0;
            var pendingNote =
              pendingCents > 0
                ? '<p class="muted" style="font-size: 0.82rem; margin: 0 0 12px 0;">' +
                  money(pendingCents / 100) +
                  " is held by a checkout that is still in progress; it comes back to the card if that checkout is abandoned.</p>"
                : "";

            balanceResult.innerHTML =
              '<div style="background: rgba(214, 155, 92, 0.1); border: 1px solid #d69b5c; border-radius: var(--radius); padding: 16px; margin-top: 12px; text-align: center;">' +
              '  <span style="font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1.5px; color: #d69b5c; font-weight: bold; display: block; margin-bottom: 4px;">Active Stored-Value Balance</span>' +
              '  <div style="font-size: 2rem; font-weight: bold; color: var(--paper); margin-bottom: 4px;">' +
              formatted +
              "</div>" +
              '  <p class="muted" style="font-size: 0.82rem; margin: 0 0 12px 0;">Code: <strong>' +
              escapeHtml(normalizeGiftCardCode(data.code) || rawCode) +
              "</strong>" +
              initial +
              " · Never Expires</p>" +
              pendingNote +
              '  <button type="button" class="btn btn-sm btn-primary" id="applyCheckedGiftCardBtn" style="border-radius: 20px;">Apply to Cart Now</button>' +
              '  <p class="muted" id="giftCardApplyStatus" role="status" style="font-size: 0.8rem; margin: 8px 0 0 0;" hidden></p>' +
              "</div>";

            var applyBtn = document.getElementById("applyCheckedGiftCardBtn");
            if (applyBtn) {
              applyBtn.addEventListener("click", function () {
                /* This used to write yl_applied_gift_card into localStorage
                   directly, inside a try/catch that swallowed every failure:
                   in private mode the click did nothing at all, and even when
                   it worked the open drawer went on showing the old total
                   because nothing told the cart to re-read storage. The cart
                   owns its own state -- hand the card to it. */
                var applied =
                  window.YLCart &&
                  typeof window.YLCart.applyGiftCard === "function" &&
                  window.YLCart.applyGiftCard({
                    code: normalizeGiftCardCode(data.code) || rawCode,
                    balance: data.balance,
                    valid: true
                  });

                if (!applied) {
                  var status = document.getElementById("giftCardApplyStatus");
                  if (status) {
                    status.hidden = false;
                    status.textContent =
                      "We couldn't apply this card automatically. Enter the code in the cart at checkout.";
                  }
                  return;
                }

                var modal = document.getElementById("giftCardModal");
                if (modal) modal.close();

                // Open cart drawer if available
                var cartToggle =
                  document.getElementById("cartToggle") || document.querySelector(".cart-toggle");
                if (cartToggle) cartToggle.click();
              });
            }
          } else if (data && data.valid && data.balance === 0) {
            balanceResult.innerHTML =
              '<div style="background: rgba(255, 255, 255, 0.05); border: 1px solid var(--hide); border-radius: var(--radius); padding: 14px; margin-top: 12px; text-align: center;">' +
              '  <p style="margin: 0; color: #e66550; font-weight: 500;">Card Fully Redeemed</p>' +
              '  <p class="muted" style="font-size: 0.82rem; margin: 4px 0 0 0;">This gift code has a remaining balance of <strong>$0</strong>.</p>' +
              "</div>";
          } else {
            balanceResult.innerHTML = errorBox(
              data && typeof data.error === "string" && /format/i.test(data.error)
                ? "That code doesn't look right. It should read YALL-XXXX-XXXX-XXXX (dashes optional)."
                : "We couldn't find a gift card with that code. Check the code in your gift email and try again."
            );
          }
        })
        .catch(function () {
          if (checkBalanceBtn) {
            checkBalanceBtn.disabled = false;
            checkBalanceBtn.textContent = "Check Balance";
          }
          balanceResult.innerHTML = errorBox("Network error checking balance. Please try again.");
        });
    });
  }

  /* The endpoint answers with an HTML error page or an empty body at least as
     often as it answers JSON, and res.json() rejects on both. Never let that
     rejection stand in for the real failure. */
  function readJson(res) {
    if (!res || typeof res.json !== "function") return Promise.resolve(null);
    var parsed;
    try {
      parsed = res.json();
    } catch {
      return Promise.resolve(null);
    }
    return Promise.resolve(parsed).then(
      function (data) {
        return data;
      },
      function () {
        return null;
      }
    );
  }

  /* Every message that reaches this box is server-supplied or shopper-typed:
     escape it on the way in, once, here. */
  function errorBox(msg) {
    return (
      '<div style="background: rgba(230, 101, 80, 0.1); border: 1px solid rgba(230, 101, 80, 0.3); border-radius: var(--radius); padding: 14px; margin-top: 12px; text-align: center;">' +
      '  <p style="margin: 0; color: #e66550; font-size: 0.88rem;">' +
      escapeHtml(msg) +
      "</p>" +
      "</div>"
    );
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // --- Purchase Flow Logic ---
  if (!presetBtns.length || !addGiftCardBtn) return;

  /* The button's label is composed with the amount in the middle ("Add $25
     Gift Card to Cart"), so the whole-text-node matcher in translator.js can
     never match it -- no single English phrase equals every amount's version
     of it (live audit LOW-1). tpl.addGiftCard is the template dictionary key
     ("Add {amount} Gift Card to Cart"); window.YL_T fills it in for whatever
     language is active right now, and falls back to plain English
     concatenation when translator.js has not loaded (e.g. this file's own
     unit tests, which run without it). lastGiftAmount is remembered so the
     "yl-language-changed" listener below can re-render the button in the
     newly selected language without needing the amount passed back in. */
  var lastGiftAmount = 25;

  function giftButtonText(amount) {
    if (typeof window !== "undefined" && typeof window.YL_T === "function") {
      return window.YL_T("tpl.addGiftCard", { amount: "$" + amount });
    }
    return "Add $" + amount + " Gift Card to Cart";
  }

  function renderGiftButtonText(amount) {
    lastGiftAmount = amount;
    var btnTextEl = document.getElementById("addGiftCardBtnText");
    if (btnTextEl) {
      btnTextEl.textContent = giftButtonText(amount);
    }
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("yl-language-changed", function () {
      renderGiftButtonText(lastGiftAmount);
    });
  }

  /* Render once at load, in whatever language is already active, instead of
     waiting for the first amount change or the next "yl-language-changed"
     event. Loading the page with ?lang=es (or a saved preference) runs
     translator.js's init() -- and its language switch, and the event this
     listens for -- before this script tag has necessarily executed, so
     without this the button shipped in English until the shopper touched a
     preset (verified live: shop.html?lang=es showed "Add $25 Gift Card to
     Cart" at load). The build always marks one preset .active (25 by
     default); read it instead of assuming, so a custom-picked amount
     mid-session survives a reload of this script correctly too. */
  (function renderInitialGiftButtonText() {
    var activePreset = null;
    for (var i = 0; i < presetBtns.length; i++) {
      if (presetBtns[i].classList.contains("active")) {
        activePreset = presetBtns[i];
        break;
      }
    }
    var initialAmount =
      activePreset && activePreset.getAttribute("data-amount")
        ? parseInt(activePreset.getAttribute("data-amount"), 10)
        : customGiftAmount && customGiftAmount.value
          ? parseInt(customGiftAmount.value, 10)
          : 25;
    renderGiftButtonText(isNaN(initialAmount) ? 25 : initialAmount);
  })();

  function updateGiftCardAmount(amount) {
    var finalAmount = amount;
    if (finalAmount < 10) finalAmount = 10;
    if (finalAmount > 500) finalAmount = 500;

    if (giftCardAmountDisplay) {
      giftCardAmountDisplay.textContent = "$" + finalAmount;
    }
    if (customGiftAmount) {
      customGiftAmount.value = finalAmount;
    }
    addGiftCardBtn.setAttribute("data-item-custom1-value", "Preset $" + finalAmount);
    renderGiftButtonText(finalAmount);
  }

  presetBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      presetBtns.forEach(function (b) {
        b.classList.remove("active");
        b.setAttribute("aria-pressed", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-pressed", "true");

      if (btn.id === "customPresetBtn") {
        if (customAmountGroup) customAmountGroup.style.display = "block";
        updateGiftCardAmount(parseInt(customGiftAmount.value, 10) || 25);
      } else {
        if (customAmountGroup) customAmountGroup.style.display = "none";
        updateGiftCardAmount(parseInt(btn.getAttribute("data-amount"), 10));
      }
    });
  });

  if (customGiftAmount) {
    var amountNote = document.getElementById("customGiftAmountNote");
    function noteAmount(raw, clamped) {
      if (!amountNote) return;
      var typed = Number(raw);
      if (raw === "" || isNaN(typed))
        amountNote.textContent = "Any whole-dollar amount from $10 to $500.";
      else if (typed < 10) amountNote.textContent = "The minimum is $10, so we've set it to $10.";
      else if (typed > 500)
        amountNote.textContent = "The maximum is $500, so we've set it to $500.";
      else if (typed !== clamped)
        amountNote.textContent = "Whole dollars only: rounded to $" + clamped + ".";
      else amountNote.textContent = "Any whole-dollar amount from $10 to $500.";
    }
    customGiftAmount.addEventListener("input", function () {
      var val = parseInt(customGiftAmount.value, 10);
      if (!isNaN(val)) {
        var clamped = val;
        if (clamped < 10) clamped = 10;
        if (clamped > 500) clamped = 500;
        noteAmount(customGiftAmount.value, clamped);
        if (giftCardAmountDisplay) giftCardAmountDisplay.textContent = "$" + clamped;
        addGiftCardBtn.setAttribute("data-item-custom1-value", "Preset $" + clamped);
        /* The button kept whatever amount was last committed ("Add $25 Gift
           Card to Cart") while the display and the cart attribute had already
           moved on, so the button contradicted the price beside it. */
        renderGiftButtonText(clamped);
      }
    });

    customGiftAmount.addEventListener("change", function () {
      var raw = customGiftAmount.value;
      var val = parseInt(raw, 10) || 25;
      if (val < 10) val = 10;
      if (val > 500) val = 500;
      noteAmount(raw, val);
      customGiftAmount.value = val;
      updateGiftCardAmount(val);
    });
  }

  if (giftRecipientEmail) {
    giftRecipientEmail.addEventListener("input", function () {
      var err = document.getElementById("giftRecipientEmailError");
      if (err) err.hidden = true;
      giftRecipientEmail.removeAttribute("aria-invalid");
      addGiftCardBtn.setAttribute("data-item-custom2-value", giftRecipientEmail.value.trim());
    });
  }
  if (giftSenderName) {
    giftSenderName.addEventListener("input", function () {
      addGiftCardBtn.setAttribute("data-item-custom3-value", giftSenderName.value.trim());
    });
  }
  if (giftMessage) {
    giftMessage.addEventListener("input", function () {
      addGiftCardBtn.setAttribute("data-item-custom4-value", giftMessage.value.trim());
    });
  }

  addGiftCardBtn.addEventListener("click", function (e) {
    if (giftRecipientEmail) {
      addGiftCardBtn.setAttribute("data-item-custom2-value", giftRecipientEmail.value.trim());
    }
    if (giftSenderName) {
      addGiftCardBtn.setAttribute("data-item-custom3-value", giftSenderName.value.trim());
    }
    if (giftMessage) {
      addGiftCardBtn.setAttribute("data-item-custom4-value", giftMessage.value.trim());
    }

    var emailError = document.getElementById("giftRecipientEmailError");
    if (giftRecipientEmail && !giftRecipientEmail.checkValidity()) {
      if (emailError) {
        emailError.textContent = giftRecipientEmail.value.trim()
          ? "That doesn't look like an email address."
          : "Add the recipient's email so we know where to send the card.";
        emailError.hidden = false;
      }
      giftRecipientEmail.setAttribute("aria-invalid", "true");
      giftRecipientEmail.focus();
      giftRecipientEmail.reportValidity();
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (giftSenderName && !giftSenderName.checkValidity()) {
      giftSenderName.reportValidity();
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    var modal = document.getElementById("giftCardModal");
    if (modal) {
      setTimeout(function () {
        modal.close();
      }, 150);
    }
  });
})();
