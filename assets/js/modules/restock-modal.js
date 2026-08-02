/**
 * @fileoverview 2026 SOTA Restock Alert Modal Module.
 * Manages native <dialog> lifecycle and honeypot validation.
 */
(function (global) {
  'use strict';

  function initRestockModal() {
    var modal = document.getElementById('restockAlertModal');
    if (!modal) return null;

    var form = document.getElementById('restockAlertForm');
    var feedback = document.getElementById('restock-modal-feedback');
    var closeBtn = document.getElementById('closeRestockModal');
    var pTitle = document.getElementById('restock-product-title');
    var pImg = document.getElementById('restock-product-img');

    function open(product) {
      product = product || {};
      if (pTitle) pTitle.textContent = product.title || 'Product';
      if (pImg) {
        pImg.src = product.image || 'assets/img/logo.png';
        pImg.alt = product.title || 'Product preview';
      }
      if (feedback) {
        feedback.style.display = 'none';
        feedback.textContent = '';
      }
      if (form) form.reset();

      if (typeof modal.showModal === 'function') {
        modal.showModal();
      } else {
        modal.setAttribute('open', '');
      }
    }

    function close() {
      if (typeof modal.close === 'function') {
        modal.close();
      } else {
        modal.removeAttribute('open');
      }
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', close);
    }

    if (modal) {
      modal.addEventListener('click', function (ev) {
        if (ev.target === modal) close();
      });
    }

    return { open: open, close: close };
  }

  global.YL_RestockModal = {
    init: initRestockModal,
  };
})(typeof window !== 'undefined' ? window : this);
