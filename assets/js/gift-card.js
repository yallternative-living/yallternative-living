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

  if (!presetBtns.length || !addGiftCardBtn) return;

  function updateGiftCardAmount(amount) {
    var finalAmount = amount;
    if (finalAmount < 10) finalAmount = 10;
    if (finalAmount > 500) finalAmount = 500;

    giftCardAmountDisplay.textContent = "$" + finalAmount;
    customGiftAmount.value = finalAmount;
    addGiftCardBtn.setAttribute("data-item-custom1-value", "Preset $" + finalAmount);
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
        customAmountGroup.style.display = "block";
        updateGiftCardAmount(parseInt(customGiftAmount.value, 10) || 25);
      } else {
        customAmountGroup.style.display = "none";
        updateGiftCardAmount(parseInt(btn.getAttribute("data-amount"), 10));
      }
    });
  });

  customGiftAmount.addEventListener("input", function () {
    var val = parseInt(customGiftAmount.value, 10);
    if (!isNaN(val)) {
      var clamped = val;
      if (clamped < 10) clamped = 10;
      if (clamped > 500) clamped = 500;
      giftCardAmountDisplay.textContent = "$" + clamped;
      addGiftCardBtn.setAttribute("data-item-custom1-value", "Preset $" + clamped);
    }
  });

  customGiftAmount.addEventListener("change", function () {
    var val = parseInt(customGiftAmount.value, 10) || 25;
    if (val < 10) val = 10;
    if (val > 500) val = 500;
    customGiftAmount.value = val;
    updateGiftCardAmount(val);
  });

  giftRecipientEmail.addEventListener("input", function () {
    addGiftCardBtn.setAttribute("data-item-custom2-value", giftRecipientEmail.value.trim());
  });
  giftSenderName.addEventListener("input", function () {
    addGiftCardBtn.setAttribute("data-item-custom3-value", giftSenderName.value.trim());
  });
  giftMessage.addEventListener("input", function () {
    addGiftCardBtn.setAttribute("data-item-custom4-value", giftMessage.value.trim());
  });

  addGiftCardBtn.addEventListener("click", function (e) {
    if (!giftRecipientEmail.checkValidity()) {
      giftRecipientEmail.reportValidity();
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (!giftSenderName.checkValidity()) {
      giftSenderName.reportValidity();
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    // Validation passed. Close modal after brief delay so Snipcart registers event.
    var modal = document.getElementById("giftCardModal");
    if (modal) {
      setTimeout(function () {
        modal.close();
      }, 150);
    }
  });
})();
