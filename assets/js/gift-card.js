(function() {
  "use strict";
  var presetBtns = document.querySelectorAll('.preset-btn');
  var customAmountGroup = document.getElementById('customAmountGroup');
  var customGiftAmount = document.getElementById('customGiftAmount');
  var giftCardAmountDisplay = document.getElementById('giftCardAmountDisplay');
  var addGiftCardBtn = document.getElementById('addGiftCardBtn');
  var giftRecipientEmail = document.getElementById('giftRecipientEmail');
  var giftSenderName = document.getElementById('giftSenderName');
  var giftMessage = document.getElementById('giftMessage');

  if (!presetBtns.length || !addGiftCardBtn) return;

  var SUPPORTED_AMOUNTS = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 150, 200, 250, 500];

  function updateGiftCardAmount(amount) {
    var closest = SUPPORTED_AMOUNTS.reduce(function(prev, curr) {
      return (Math.abs(curr - amount) < Math.abs(prev - amount) ? curr : prev);
    });
    
    giftCardAmountDisplay.textContent = '$' + closest;
    customGiftAmount.value = closest;
    addGiftCardBtn.setAttribute('data-item-custom1-value', 'Preset $' + closest);
  }

  presetBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      presetBtns.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      
      if (btn.id === 'customPresetBtn') {
        customAmountGroup.style.display = 'block';
        updateGiftCardAmount(parseInt(customGiftAmount.value, 10) || 25);
      } else {
        customAmountGroup.style.display = 'none';
        updateGiftCardAmount(parseInt(btn.getAttribute('data-amount'), 10));
      }
    });
  });

  customGiftAmount.addEventListener('change', function() {
    var val = parseInt(customGiftAmount.value, 10) || 25;
    if (val < 10) val = 10;
    if (val > 500) val = 500;
    updateGiftCardAmount(val);
  });

  giftRecipientEmail.addEventListener('input', function() {
    addGiftCardBtn.setAttribute('data-item-custom2-value', giftRecipientEmail.value.trim());
  });
  giftSenderName.addEventListener('input', function() {
    addGiftCardBtn.setAttribute('data-item-custom3-value', giftSenderName.value.trim());
  });
  giftMessage.addEventListener('input', function() {
    addGiftCardBtn.setAttribute('data-item-custom4-value', giftMessage.value.trim());
  });

  addGiftCardBtn.addEventListener('click', function(e) {
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
  });
})();
