/**
 * @fileoverview 2026 SOTA UGC Social Proof Feed Module.
 * Decouples social proof card rendering and path safety.
 */
(function (global) {
  'use strict';

  function attrEsc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function safeUrl(url) {
    if (!url) return '';
    var str = String(url).trim();
    if (
      str.indexOf('http://') === 0 ||
      str.indexOf('https://') === 0 ||
      str.indexOf('/') === 0 ||
      str.indexOf('assets/') === 0
    ) {
      return str;
    }
    return '';
  }

  function renderUgcCard(post) {
    var altText = post.caption
      ? "Customer community photo: " + post.caption.slice(0, 80)
      : "Y'allternative Living customer post";

    var productTagHtml = '';
    if (post.productId && post.productName) {
      productTagHtml =
        '<a href="shop.html#' +
        attrEsc(post.productId) +
        '" class="ugc-product-tag" aria-label="View ' +
        attrEsc(post.productName) +
        ' in shop">' +
        '  <svg class="yl-icon" aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg> ' +
        attrEsc(post.productName) +
        '</a>';
    }

    var postLink = safeUrl(post.url);
    var linkHtml = postLink
      ? '<a href="' +
        attrEsc(postLink) +
        '" target="_blank" rel="noopener" class="ugc-post-link" aria-label="View original post by ' +
        attrEsc(post.handle || '@yallternativeliving') +
        ' (opens in new tab)">View Post &#8599;<span class="sr-only"> (opens in new tab)</span></a>'
      : '';

    return (
      /* A <div>, not an <article>: role="listitem" is not a valid role
         override for <article>, so each card announced itself as a stray
         article instead of as item N of the surrounding role="list"
         feed (axe aria-allowed-role). */
      '<div class="ugc-card reveal" role="listitem">' +
      '  <div class="ugc-card-media">' +
      '    <img src="' +
      attrEsc(safeUrl(post.image)) +
      '" alt="' +
      attrEsc(altText) +
      '" loading="lazy" decoding="async" width="400" height="400">' +
      '    <div class="ugc-media-badge">' +
      '      <svg class="yl-icon" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1"/></svg>' +
      '      <span>UGC</span>' +
      '    </div>' +
      productTagHtml +
      '  </div>' +
      '  <div class="ugc-card-body">' +
      '    <div class="ugc-author-row">' +
      '      <span class="ugc-author-name">' +
      attrEsc(post.author || 'Community Member') +
      '</span>' +
      '      <span class="ugc-author-handle">' +
      attrEsc(post.handle || '@yallternativeliving') +
      '</span>' +
      '    </div>' +
      '    <p class="ugc-caption">' +
      attrEsc(post.caption) +
      '</p>' +
      linkHtml +
      '  </div>' +
      '</div>'
    );
  }

  function renderFeed(gridElem, sectionElem, options) {
    options = options || {};
    var enableFeed = options.enableFeed !== undefined ? options.enableFeed : true;
    if (!enableFeed || !gridElem || !sectionElem || !global.YL_SOCIAL_FEED) return;

    var posts = global.YL_SOCIAL_FEED.posts || [];
    if (posts.length === 0) return;

    sectionElem.style.display = 'block';
    gridElem.innerHTML = posts.map(renderUgcCard).join('');

    if (typeof global.wireReveal === 'function') {
      global.wireReveal(gridElem);
    }
  }

  global.YL_UGCFeed = {
    renderCard: renderUgcCard,
    renderFeed: renderFeed,
  };
})(typeof window !== 'undefined' ? window : this);
