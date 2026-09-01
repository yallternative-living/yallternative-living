(function () {
  "use strict";
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
      var rawCode = balanceInput.value.trim().toUpperCase();
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
      // The function takes {code} as a JSON body and answers no-store.
      fetch("/.netlify/functions/gift-card-balance", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ code: rawCode })
      })
        .then(function (res) {
          return res.json().catch(function () {
            return { valid: false, error: "Invalid response from server" };
          });
        })
        .then(function (data) {
          if (checkBalanceBtn) {
            checkBalanceBtn.disabled = false;
            checkBalanceBtn.textContent = "Check Balance";
          }

          if (data && data.valid && data.balance > 0) {
            // Server-supplied text, interpolated into innerHTML: escape it.
            var formatted = escapeHtml(
              data.formattedBalance || "$" + Number(data.balance).toFixed(2)
            );
            var initial = data.initialAmount
              ? " (of $" + Number(data.initialAmount).toFixed(2) + " initial)"
              : "";

            balanceResult.innerHTML =
              '<div style="background: rgba(214, 155, 92, 0.1); border: 1px solid #d69b5c; border-radius: var(--radius); padding: 16px; margin-top: 12px; text-align: center;">' +
              '  <span style="font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1.5px; color: #d69b5c; font-weight: bold; display: block; margin-bottom: 4px;">Active Stored-Value Balance</span>' +
              '  <div style="font-size: 2rem; font-weight: bold; color: var(--paper); margin-bottom: 4px;">' +
              formatted +
              "</div>" +
              '  <p class="muted" style="font-size: 0.82rem; margin: 0 0 12px 0;">Code: <strong>' +
              escapeHtml(data.code || rawCode) +
              "</strong>" +
              initial +
              " · Never Expires</p>" +
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
                    code: data.code || rawCode,
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
              '  <p class="muted" style="font-size: 0.82rem; margin: 4px 0 0 0;">This gift code has a remaining balance of <strong>$0.00</strong>.</p>' +
              "</div>";
          } else {
            var msg =
              data && data.error ? data.error : "Gift card code not found or invalid format.";
            balanceResult.innerHTML =
              '<div style="background: rgba(230, 101, 80, 0.1); border: 1px solid rgba(230, 101, 80, 0.3); border-radius: var(--radius); padding: 14px; margin-top: 12px; text-align: center;">' +
              '  <p style="margin: 0; color: #e66550; font-size: 0.88rem;">' +
              escapeHtml(msg) +
              "</p>" +
              "</div>";
          }
        })
        .catch(function () {
          if (checkBalanceBtn) {
            checkBalanceBtn.disabled = false;
            checkBalanceBtn.textContent = "Check Balance";
          }
          balanceResult.innerHTML =
            '<div style="background: rgba(230, 101, 80, 0.1); border: 1px solid rgba(230, 101, 80, 0.3); border-radius: var(--radius); padding: 14px; margin-top: 12px; text-align: center;">' +
            '  <p style="margin: 0; color: #e66550; font-size: 0.88rem;">Network error checking balance. Please try again.</p>' +
            "</div>";
        });
    });
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
    var btnTextEl = document.getElementById("addGiftCardBtnText");
    if (btnTextEl) {
      btnTextEl.textContent = "Add $" + finalAmount + " Gift Card to Cart";
    }
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
    customGiftAmount.addEventListener("input", function () {
      var val = parseInt(customGiftAmount.value, 10);
      if (!isNaN(val)) {
        var clamped = val;
        if (clamped < 10) clamped = 10;
        if (clamped > 500) clamped = 500;
        if (giftCardAmountDisplay) giftCardAmountDisplay.textContent = "$" + clamped;
        addGiftCardBtn.setAttribute("data-item-custom1-value", "Preset $" + clamped);
        /* The button kept whatever amount was last committed ("Add $25 Gift
           Card to Cart") while the display and the cart attribute had already
           moved on, so the button contradicted the price beside it. */
        var btnTextEl = document.getElementById("addGiftCardBtnText");
        if (btnTextEl) {
          btnTextEl.textContent = "Add $" + clamped + " Gift Card to Cart";
        }
      }
    });

    customGiftAmount.addEventListener("change", function () {
      var val = parseInt(customGiftAmount.value, 10) || 25;
      if (val < 10) val = 10;
      if (val > 500) val = 500;
      customGiftAmount.value = val;
      updateGiftCardAmount(val);
    });
  }

  if (giftRecipientEmail) {
    giftRecipientEmail.addEventListener("input", function () {
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

    if (giftRecipientEmail && !giftRecipientEmail.checkValidity()) {
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
