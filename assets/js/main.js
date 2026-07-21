/* ==========================================================
   Y'ALLTERNATIVE LIVING | shared site behavior
   Zero dependencies, zero build step. Vanilla JS only so the
   whole site stays instant on any connection.
   ========================================================== */
(function () {
  "use strict";

  /* ---------- Theme toggle (dark/light, persisted) ---------- */
  var root = document.documentElement;
  var toggle = document.getElementById("themeToggle");

  function currentTheme() {
    // Storage access can throw (Safari private browsing, "block all
    // cookies," a locked-down webview) -- this runs as the very first
    // statement in the whole file, so an uncaught throw here used to
    // kill every other feature on the page (nav, cart, wishlist, shop
    // rendering, everything). Falling back to matchMedia keeps the
    // theme correct and lets the rest of the script keep running.
    try {
      var saved = localStorage.getItem("yl-theme");
      if (saved === "dark" || saved === "light") return saved;
    } catch (e) {
      /* storage unavailable -- fall through to the media-query default */
    }
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    if (toggle) toggle.setAttribute("aria-checked", theme === "light" ? "true" : "false");
  }

  applyTheme(currentTheme());

  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      try {
        localStorage.setItem("yl-theme", next);
      } catch (e) {
        /* can't persist -- still flip the theme for this page view */
      }
      if (typeof window.plausible === "function") {
        window.plausible("Theme Toggled", { props: { theme: next } });
      }
      applyTheme(next);
    });
  }

  /* ---------- Mobile nav ---------- */
  var navToggle = document.querySelector(".nav-toggle");
  var navLinks = document.querySelector(".nav-links");
  if (navToggle && navLinks) {
    /* Below 880px, .nav-links is visually hidden (opacity/transform)
       when closed, but it's still `position:fixed` and covers most of
       the viewport, and being visually hidden doesn't remove its links
       from the tab order or a screen reader's accessibility tree. A
       keyboard user tabbing past the hamburger would land on invisible
       links, and a mobile screen-reader user swiping through the page
       would hit them too. `inert` removes closed-panel links from both
       until the panel is actually open. Above 1024px the panel is always
       visible inline, so it should never be inert there. */
    var navMQ = window.matchMedia("(max-width: 1024px)");
    function syncNavInert() {
      if (navMQ.matches && !navLinks.classList.contains("open")) {
        navLinks.setAttribute("inert", "");
      } else {
        navLinks.removeAttribute("inert");
      }
    }
    syncNavInert();
    navMQ.addEventListener("change", syncNavInert);

    function closeNav() {
      navLinks.classList.remove("open");
      navToggle.setAttribute("aria-expanded", "false");
      navToggle.setAttribute("aria-label", "Open menu");
      navToggle.textContent = "☰";
      syncNavInert();
    }

    navToggle.addEventListener("click", function () {
      var open = navLinks.classList.toggle("open");
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
      navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      navToggle.textContent = open ? "✕" : "☰";
      syncNavInert();
      /* nav-toggle sits after nav-links in the DOM (it lives inside
         nav-cta), so a keyboard user who just opened the menu and hits
         Tab would move into page content, not into the menu they just
         opened -- there's nothing later in tab order pointing back at
         it. Moving focus straight into the first link sidesteps the
         whole DOM-order problem instead of fighting it. */
      if (open) {
        var firstLink = navLinks.querySelector("a");
        if (firstLink) firstLink.focus();
      }
    });
    navLinks.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", closeNav);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && navLinks.classList.contains("open")) {
        closeNav();
        navToggle.focus();
      }
    });
    document.addEventListener("click", function (e) {
      if (
        navLinks.classList.contains("open") &&
        !navLinks.contains(e.target) &&
        !navToggle.contains(e.target)
      ) {
        closeNav();
      }
    });
  }

  /* ---------- Scroll reveal (IntersectionObserver) ----------
     Shared by the initial page-load pass below, the shop grid
     (renderCards, re-run on every filter/sort), and the events page
     (markReveal). A fresh observer used to get created on every single
     re-render with no way to ever release the previous one -- any
     `.reveal` element still unobserved at re-render time (scrolled past
     but not yet intersected) stayed pinned to an abandoned observer
     instance forever. Stashing the current observer on the root element
     and disconnecting it before making a new one closes that leak. */
  function wireReveal(root, options) {
    var els = root.querySelectorAll(".reveal");
    if (root.__revealIO) {
      root.__revealIO.disconnect();
      root.__revealIO = null;
    }
    if (!("IntersectionObserver" in window) || !els.length || window.navigator.webdriver) {
      els.forEach(function (el) {
        el.classList.add("in");
      });
      return;
    }
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            io.unobserve(entry.target);
          }
        });
      },
      options || { threshold: 0.1 }
    );
    els.forEach(function (el, i) {
      el.style.setProperty("--i", i % 8);
      io.observe(el);
    });
    root.__revealIO = io;
  }
  wireReveal(document, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });

  /* ---------- Footer year ---------- */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---------- Newsletter signup: honeypot guard ----------
     The hidden "leave this field blank" input in the footer signup
     form is invisible and untabbable for real visitors, but simple
     spam bots often fill in every field they find. If it's non-empty
     on submit we quietly drop that one submission instead of sending
     it on -- no account, backend, or paid service needed for this.
     This degrades safely: with JS off, the field just stays blank
     (real people can't see it to fill it in) and the form still posts
     normally straight to the email provider. */
  var signupForms = document.querySelectorAll(".footer-signup-form");
  signupForms.forEach(function (form) {
    form.addEventListener("submit", function (e) {
      var hp = form.querySelector('input[name="footer_website"]');
      if (hp && hp.value) {
        e.preventDefault();
        return;
      }

      // Check if this is local testing / placeholder action URL
      if (form.action.indexOf("YOUR_KIT_FORM_ACTION_URL") !== -1) {
        e.preventDefault();
        var box = form.closest(".footer-signup");
        if (box) box.classList.add("is-subscribed");
        return;
      }

      // Submit via AJAX (fetch) to prevent page reload/redirect
      e.preventDefault();
      var button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = "Joining...";

      fetch(form.action, {
        method: "POST",
        body: new FormData(form),
        mode: "no-cors"
      })
        .then(function () {
          var box = form.closest(".footer-signup");
          if (box) box.classList.add("is-subscribed");
        })
        .catch(function () {
          // Fallback to standard form submit in case of network issues
          form.submit();
        });
    });
  });

  /* ---------- Newsletter signup: post-redirect confirmation ----------
     The actual subscribe is a real, un-intercepted POST straight to
     the email provider (see the form's real action URL once it's set
     up -- README has the steps). Its dashboard's "redirect after
     subscribing" setting is configured to send visitors back here
     with ?subscribed=1 in the URL. This just swaps the footer signup
     box over to a thank-you state if that flag shows up on load, then
     cleans the flag out of the address bar. */
  if (window.location.search.indexOf("subscribed=1") !== -1) {
    var signupBoxes = document.querySelectorAll(".footer-signup");
    signupBoxes.forEach(function (box) {
      box.classList.add("is-subscribed");
    });
    if (typeof window.plausible === "function") {
      window.plausible("Newsletter Signup");
    }
    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    }
  }

  // Gift Card Modal controller (SOTA 2026 Native Dialog Pattern)
  var giftModal = document.getElementById("giftCardModal");
  if (giftModal) {
    // 1. Open modal via CTA buttons or by clicking the gift card product card itself
    document.addEventListener("click", function (e) {
      var target = e.target.closest('a[href="#gift-cards"]');
      if (!target) {
        var card = e.target.closest('.card[data-id="yallternative-gift-card"]');
        if (card && !e.target.closest(".wish-btn") && !e.target.closest(".card-gallery-dot")) {
          target = card;
        }
      }
      if (target) {
        e.preventDefault();
        giftModal.showModal();
        // Focus recipient email after modal transition starts
        setTimeout(function () {
          var emailInput = document.getElementById("giftRecipientEmail");
          if (emailInput) emailInput.focus();
        }, 50);
      }
    });

    // 2. Close modal via close button
    var closeBtn = document.getElementById("closeGiftModalBtn");
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        giftModal.close();
      });
    }

    // 3. Fallback light-dismiss for older browsers that lack native closedby support
    if (!("closedBy" in HTMLDialogElement.prototype)) {
      giftModal.addEventListener("click", function (event) {
        if (event.target !== giftModal) return;
        var rect = giftModal.getBoundingClientRect();
        var isDialogContent =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;
        if (!isDialogContent) {
          giftModal.close();
        }
      });
    }

    // 4. Automatically open if hash matches on load
    if (window.location.hash === "#gift-cards") {
      giftModal.showModal();
    }
  }

  /* ---------- Review form (shop.html): honeypot + AJAX submit ----------
     Same honeypot pattern as the newsletter form above (shared .form-hp
     CSS, a differently-named hidden input so the two forms' bot checks
     stay independent). Submissions post to Formspree (see YOUR_FORMSPREE_
     FORM_ID in shop.html) which emails every one to Savanna for a manual
     look -- nothing here publishes a review automatically. See
     assets/js/site-reviews-data.js for the full moderation workflow.

     Unlike the newsletter form, this one submits via fetch() so the
     visitor gets an inline "thanks" message without leaving shop.html
     (Formspree's own default is to redirect to its own confirmation
     page). If fetch isn't available, or Formspree's AJAX endpoint
     rejects the request for any reason, it falls back to a plain form
     submit -- still reaches Savanna's inbox, just via a full page POST. */
  var reviewForms = document.querySelectorAll(".review-form");
  reviewForms.forEach(function (form) {
    form.addEventListener("submit", function (e) {
      var hp = form.querySelector('input[name="review_website"]');
      if (hp && hp.value) {
        e.preventDefault();
        return;
      }

      if (!window.fetch) return; // let the native POST proceed with JS off/unsupported
      e.preventDefault();
      var wrap = form.closest(".review-form-wrap");
      fetch(form.action, {
        method: "POST",
        body: new FormData(form),
        headers: { Accept: "application/json" }
      })
        .then(function (res) {
          if (res.ok) {
            if (wrap) wrap.classList.add("is-submitted");
            form.reset();
          } else {
            form.submit();
          }
        })
        .catch(function () {
          form.submit();
        });
    });
  });

  /* ---------- Contact form submit handler (AJAX via Formspree) ---------- */
  var contactForms = document.querySelectorAll(".contact-form");
  contactForms.forEach(function (form) {
    form.addEventListener("submit", function (e) {
      var col = form.closest(".contact-form-col");
      if (form.action.indexOf("YOUR_FORM_ID") !== -1) {
        e.preventDefault();
        if (col) col.classList.add("is-submitted");
        return;
      }
      if (!window.fetch) return;
      e.preventDefault();
      fetch(form.action, {
        method: "POST",
        body: new FormData(form),
        headers: { Accept: "application/json" }
      })
        .then(function (res) {
          if (res.ok) {
            if (col) col.classList.add("is-submitted");
            form.reset();
          } else {
            form.submit();
          }
        })
        .catch(function () {
          form.submit();
        });
    });
  });

  /* ---------- Wishlist / "Saved For Later" (localStorage, no backend) ----------
     A client-side save list that persists in the shopper's browser --
     nothing to sign in to, nothing server-side to build. Every saved
     item's real path to purchase is "Add to Cart" -> Snipcart checkout,
     right here on the site (see addToCartHTML() above); this doesn't
     link out to Etsy or anywhere else. */
  var WISH_KEY = "yl-wishlist";
  var wishHeartSVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">' +
    '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>';

  /* ---------- shared: escape a value for safe use inside an HTML attribute ---------- */
  function attrEsc(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /* Builds a <picture> element from assets/js/image-manifest.js (generated
     by scripts/optimize-images.js), serving AVIF first (smallest, ~2026-
     universal browser support), WebP second for the rare AVIF holdout,
     and the original JPG last as a fallback for anything that supports
     neither -- <picture> always uses the first <source> whose type the
     browser understands, so listing them in that order is what makes the
     preference order work. If a photo hasn't been run through the
     optimizer yet (e.g. brand new, script not re-run), this just falls
     back to a plain <img> -- nothing breaks. */
  function pictureHTML(p, opts) {
    opts = opts || {};
    // imagePath lets a caller render a photo OTHER than the product's
    // primary p.image -- used by cardGalleryHTML() below to render each
    // additional gallery photo through the same responsive <picture>
    // markup/manifest lookup as the hero shot.
    var imagePath = opts.imagePath || p.image;
    var manifest = window.YL_IMAGES && window.YL_IMAGES[imagePath];
    var alt = attrEsc(opts.alt || p.name);
    var imgAttrs =
      ' alt="' +
      alt +
      '"' +
      ' width="' +
      (opts.width || 600) +
      '"' +
      ' height="' +
      (opts.height || 510) +
      '"' +
      ' loading="' +
      (opts.loading || "lazy") +
      '"' +
      ' decoding="' +
      (opts.decoding || "async") +
      '"' +
      (opts.fetchpriority ? ' fetchpriority="' + opts.fetchpriority + '"' : "");

    var avifVariants = manifest && manifest.variants && manifest.variants.avif;
    var webpVariants = manifest && manifest.variants && manifest.variants.webp;
    if (!avifVariants && !webpVariants) {
      return '<img src="' + attrEsc(imagePath) + '"' + imgAttrs + ">";
    }

    if (opts.single) {
      // Fixed small size everywhere (wishlist thumbnail) -- one source
      // per format is enough, no need for a full responsive srcset.
      var sources = "";
      if (avifVariants && avifVariants.length)
        sources += '<source type="image/avif" srcset="' + attrEsc(avifVariants[0].file) + '">';
      if (webpVariants && webpVariants.length)
        sources += '<source type="image/webp" srcset="' + attrEsc(webpVariants[0].file) + '">';
      return (
        "<picture>" + sources + '<img src="' + attrEsc(imagePath) + '"' + imgAttrs + "></picture>"
      );
    }

    var sizes = opts.sizes || "(max-width: 600px) 100vw, (max-width: 980px) 50vw, 33vw";
    var sourcesFull = "";
    if (avifVariants && avifVariants.length) {
      var avifSrcset = avifVariants
        .map(function (v) {
          return attrEsc(v.file) + " " + v.width + "w";
        })
        .join(", ");
      sourcesFull +=
        '<source type="image/avif" srcset="' + avifSrcset + '" sizes="' + attrEsc(sizes) + '">';
    }
    if (webpVariants && webpVariants.length) {
      var webpSrcset = webpVariants
        .map(function (v) {
          return attrEsc(v.file) + " " + v.width + "w";
        })
        .join(", ");
      sourcesFull +=
        '<source type="image/webp" srcset="' + webpSrcset + '" sizes="' + attrEsc(sizes) + '">';
    }
    return (
      "<picture>" + sourcesFull + '<img src="' + attrEsc(imagePath) + '"' + imgAttrs + "></picture>"
    );
  }

  /* ---------- Shop-card photo gallery ----------
     Most products now have a couple of extra real Etsy listing photos
     in p.images (in addition to the primary p.image). Products with no
     extras just render the single <picture> as before -- this only
     kicks in once there's more than one photo to show. Dots are real
     <button>s (native keyboard/AT support) sized to a 24x24 hit target
     per WCAG 2.2's target-size guidance, even though the visible dot
     itself stays small.

     Only the first (active) slide gets real <picture>/<img> markup up
     front. The rest are left as empty placeholders carrying the image
     path in data-image, hydrated into real markup on first interaction
     (see hydrateGallerySlide below). This matters because these six
     "extra photo" products are also the homepage's featured picks --
     native loading="lazy" fires off viewport PROXIMITY, not CSS
     visibility, so eagerly rendering every alt photo's <img> would
     silently download 3-4x the bytes for every featured card the
     moment the homepage loads, even though most visitors never click
     a dot. */
  function cardGalleryHTML(p, opts) {
    opts = opts || {};
    // eager: true is only ever passed for the first handful of cards on
    // an initial, unfiltered page load (see renderCards) -- those are the
    // ones actually above the fold and likely to be the page's real LCP
    // element, so they should never be loading="lazy" (which hides them
    // from the browser's preload scanner until JS finishes running).
    var firstSlideOpts = opts.eager
      ? { width: 600, height: 510, loading: "eager", fetchpriority: "high" }
      : { width: 600, height: 510 };
    var extra = Array.isArray(p.images) ? p.images : [];
    var allImages = [p.image].concat(extra);
    if (allImages.length <= 1) {
      return pictureHTML(p, firstSlideOpts);
    }
    var slides = allImages
      .map(function (imgPath, i) {
        if (i === 0) {
          var o = Object.assign({}, firstSlideOpts, { imagePath: imgPath });
          return (
            '<div class="card-gallery-slide active" data-idx="0">' + pictureHTML(p, o) + "</div>"
          );
        }
        return (
          '<div class="card-gallery-slide" data-idx="' +
          i +
          '" data-image="' +
          attrEsc(imgPath) +
          '"></div>'
        );
      })
      .join("");
    var dots = allImages
      .map(function (_, i) {
        return (
          '<button type="button" class="card-gallery-dot' +
          (i === 0 ? " active" : "") +
          '"' +
          ' data-idx="' +
          i +
          '"' +
          ' aria-label="View photo ' +
          (i + 1) +
          " of " +
          allImages.length +
          " for " +
          attrEsc(p.name) +
          '"' +
          ' aria-pressed="' +
          (i === 0 ? "true" : "false") +
          '"></button>'
        );
      })
      .join("");
    return (
      '<div class="card-gallery" data-count="' +
      allImages.length +
      '" data-product-id="' +
      attrEsc(p.id) +
      '">' +
      slides +
      '<div class="card-gallery-dots">' +
      dots +
      "</div>" +
      "</div>"
    );
  }

  /* ---------- Snipcart "Add to Cart" button builder ----------
     Every button points data-item-url at the same static JSON manifest
     (assets/data/snipcart-products.json, auto-generated from
     products-data.js). That's Snipcart's documented pattern for
     JS-rendered/SPA-style catalogs: since our product cards are built
     client-side (not one static HTML page per product), Snipcart's
     default HTML crawler would find an empty <div> when it tries to
     validate an order. Pointing every item at one JSON endpoint instead
     makes order validation actually work. See:
     https://docs.snipcart.com/v3/setup/order-validation#json-crawler */
  function addToCartHTML(p, extraClass) {
    if (p.id === "yallternative-gift-card") {
      return (
        '<a href="#gift-cards" class="btn btn-secondary btn-sm' +
        (extraClass ? " " + extraClass : "") +
        '">Configure Card</a>'
      );
    }

    // Real Etsy listings for some products sell more than one size/scent/
    // blend under a single listing (see p.variants, sourced from actual
    // listing research). Snipcart's own custom-field mechanism handles
    // this natively: data-item-customN-options declares every choice and
    // its price delta, data-item-customN-value is the one currently
    // selected. variantSelectHTML()'s change handler keeps -value (and
    // the base data-item-price for delta'd variants) in sync with
    // whatever the shopper picks before they click this button.
    var variantAttrs = "";
    if (p.variants && Array.isArray(p.variants.options) && p.variants.options.length) {
      var optionsStr = p.variants.options
        .map(function (o) {
          var delta = o.priceDelta || 0;
          var sign = delta < 0 ? "-" : "+";
          return attrEsc(o.label) + "[" + sign + Math.abs(delta).toFixed(2) + "]";
        })
        .join("|");
      variantAttrs =
        ' data-item-custom1-name="' +
        attrEsc(p.variants.name) +
        '"' +
        ' data-item-custom1-options="' +
        optionsStr +
        '"' +
        ' data-item-custom1-value="' +
        attrEsc(p.variants.options[0].label) +
        '"';
    }

    // Real, honest sold-out state: p.stock is a manually-maintained field
    // in products-data.js (never fabricated -- undefined/null means "not
    // tracked," not "unlimited," and the site never invents a number).
    // When Savanna sets it to 0, the button becomes inert instead of
    // silently accepting an order she can't fulfill.
    if (p.comingSoon) {
      return (
        '<button type="button" class="btn btn-outline btn-sm' +
        (extraClass ? " " + extraClass : "") +
        '" disabled aria-disabled="true">Coming Soon</button>'
      );
    }

    if (p.stock === 0) {
      return (
        '<button type="button" class="btn btn-outline btn-sm' +
        (extraClass ? " " + extraClass : "") +
        '" disabled aria-disabled="true">Sold Out</button>'
      );
    }

    // data-item-max-quantity is Snipcart's own documented per-order cap
    // (docs.snipcart.com/v2/configuration/product-definition) -- real and
    // HTML-only, unlike a live decrementing counter, which requires the
    // Snipcart dashboard's own Inventory feature tied to a real account
    // (see DEVELOPMENT.md section 8). Only added when a real count exists.
    var stockAttrs =
      typeof p.stock === "number" && p.stock > 0 ? ' data-item-max-quantity="' + p.stock + '"' : "";

    return (
      '<button type="button" class="btn btn-primary btn-sm snipcart-add-item' +
      (extraClass ? " " + extraClass : "") +
      '"' +
      ' data-item-id="' +
      attrEsc(p.id) +
      '"' +
      ' data-item-name="' +
      attrEsc(p.name) +
      '"' +
      ' data-item-price="' +
      p.price.toFixed(2) +
      '"' +
      ' data-item-url="/assets/data/snipcart-products.json"' +
      ' data-item-description="' +
      attrEsc(p.blurb) +
      '"' +
      ' data-item-image="' +
      attrEsc(p.image) +
      '"' +
      ' data-item-categories="' +
      attrEsc(p.category) +
      '"' +
      variantAttrs +
      stockAttrs +
      ">" +
      "Add to Cart" +
      "</button>"
    );
  }

  /* Honest low-stock/sold-out badge -- only ever rendered when Savanna has
     actually set a real p.stock number for that product. LOW_STOCK_THRESHOLD
     is a common, reasonable urgency-signal convention (roughly the point a
     shopper should worry it might sell out before they act), not a magic
     number tied to real analytics. */
  var LOW_STOCK_THRESHOLD = 5;
  function stockBadgeHTML(p) {
    if (p.comingSoon) return '<span class="stock-badge low-stock">Coming Soon</span>';
    if (typeof p.stock !== "number") return "";
    if (p.stock === 0) return '<span class="stock-badge sold-out">Sold out</span>';
    if (p.stock <= LOW_STOCK_THRESHOLD)
      return '<span class="stock-badge low-stock">Only ' + p.stock + " left</span>";
    return "";
  }

  /* ---------- Size/scent/blend picker (only for products that have one) ----------
     The <option> value doubles as the exact label Snipcart's custom-field
     value must match; data-delta feeds the price-update math in the
     change handler below. Real <select> means full keyboard/AT support
     for free -- no custom listbox widget needed for something this simple. */
  function variantSelectHTML(p) {
    if (p.id === "yallternative-gift-card") return "";
    if (!p.variants || !Array.isArray(p.variants.options) || !p.variants.options.length) return "";
    var options = p.variants.options
      .map(function (o) {
        var delta = o.priceDelta || 0;
        var priceSuffix = delta
          ? " (" + (delta < 0 ? "-$" + Math.abs(delta).toFixed(2) : "+$" + delta.toFixed(2)) + ")"
          : "";
        return (
          '<option value="' +
          attrEsc(o.label) +
          '" data-delta="' +
          delta +
          '">' +
          attrEsc(o.label) +
          priceSuffix +
          "</option>"
        );
      })
      .join("");
    return (
      '<label class="variant-select-wrap">' +
      /* Visible, not sr-only -- a bare unlabeled <select> made it easy
         for a sighted shopper to add to cart without ever noticing a
         Size/Scent/Blend choice existed at all. aria-label stays on the
         <select> itself since it's more specific ("Size for Tank Top")
         than the short visible caption alone would convey out of context. */
      '<span class="variant-select-label">' +
      attrEsc(p.variants.name) +
      "</span>" +
      '<select class="variant-select" data-base-price="' +
      p.price +
      '" aria-label="' +
      attrEsc(p.variants.name) +
      " for " +
      attrEsc(p.name) +
      '">' +
      options +
      "</select>" +
      "</label>"
    );
  }

  /**
   * Retrieves the current wishlist array from localStorage.
   * Falls back to an empty array if storage is unavailable or corrupted.
   *
   * @return {!Array<string>} An array of product ID strings.
   */
  function getWishlist() {
    try {
      return JSON.parse(localStorage.getItem(WISH_KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  /**
   * Saves the current wishlist array to localStorage and updates UI.
   *
   * @param {!Array<string>} list An array of product ID strings.
   */
  function saveWishlist(list) {
    try {
      localStorage.setItem(WISH_KEY, JSON.stringify(list));
    } catch (e) {
      /* storage unavailable -- badge/drawer below still reflect this
         session's in-memory state, it just won't persist on reload */
    }
    updateWishBadge();
    renderWishDrawer();
  }

  /**
   * Checks if a product ID is currently present in the wishlist.
   *
   * @param {string} id The product ID string.
   * @return {boolean} True if the product is in the wishlist, false otherwise.
   */
  function isWished(id) {
    return getWishlist().indexOf(id) !== -1;
  }

  /**
   * Toggles the presence of a product ID in the wishlist and updates UI states.
   * Also updates the aria-label of the wishlist buttons for screen readers.
   *
   * @param {string} id The product ID string.
   */
  function toggleWish(id) {
    var list = getWishlist();
    var i = list.indexOf(id);
    if (i === -1) list.push(id);
    else list.splice(i, 1);
    saveWishlist(list);
    document.querySelectorAll('.wish-btn[data-id="' + id + '"]').forEach(function (btn) {
      var active = list.indexOf(id) !== -1;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
      var oldLabel = btn.getAttribute("aria-label");
      if (oldLabel) {
        if (active) {
          btn.setAttribute(
            "aria-label",
            oldLabel.replace("Save ", "Remove ").replace(" for later", " from saved items")
          );
        } else {
          btn.setAttribute(
            "aria-label",
            oldLabel.replace("Remove ", "Save ").replace(" from saved items", " for later")
          );
        }
      }
    });
  }

  /**
   * Updates the text content of the header wishlist count badge.
   */
  function updateWishBadge() {
    var badge = document.getElementById("wishCount");
    if (badge) badge.textContent = getWishlist().length > 0 ? String(getWishlist().length) : "";
  }
  function initWishNavButton() {
    var navCta = document.querySelector(".nav-cta");
    if (!navCta || document.getElementById("wishToggle")) return;
    var btn = document.createElement("button");
    btn.className = "wish-toggle";
    btn.id = "wishToggle";
    btn.type = "button";
    btn.setAttribute("aria-label", "Open your saved items");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "wishDrawer");
    btn.innerHTML = wishHeartSVG + '<span class="badge" id="wishCount" aria-live="polite"></span>';
    navCta.insertBefore(btn, navCta.firstChild);
    btn.addEventListener("click", openWishDrawer);
    updateWishBadge();
  }
  function ensureWishDrawer() {
    if (document.getElementById("wishDrawer")) return;
    var backdrop = document.createElement("div");
    backdrop.className = "wish-backdrop";
    backdrop.id = "wishBackdrop";
    var drawer = document.createElement("aside");
    drawer.className = "wish-drawer";
    drawer.id = "wishDrawer";
    drawer.setAttribute("aria-label", "Saved items");
    /* Same off-canvas-but-still-in-the-DOM issue as the mobile nav below:
       closed just moves the drawer off-screen via transform, so its
       close/checkout/remove buttons stay tabbable and screen-reader-
       visible unless explicitly made inert while closed. */
    drawer.setAttribute("inert", "");
    drawer.innerHTML =
      '<div class="wish-drawer-head"><h3>Saved For Later</h3>' +
      '<button class="wish-drawer-close" id="wishClose" type="button" aria-label="Close saved items">&times;</button></div>' +
      '<div class="wish-drawer-body" id="wishBody"></div>' +
      '<div class="wish-drawer-foot">' +
      '<button class="btn btn-primary btn-block snipcart-checkout" type="button">View Cart &amp; Checkout</button>' +
      '<p class="muted">Saved items live in this browser only. Tap "Add to Cart" on anything above, then check out securely right here.</p>' +
      "</div>";
    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);
    backdrop.addEventListener("click", closeWishDrawer);
    document.getElementById("wishClose").addEventListener("click", closeWishDrawer);
  }

  document.addEventListener("keydown", function (e) {
    var drawer = document.getElementById("wishDrawer");
    if (!drawer) return;
    if (e.key === "Escape") {
      closeWishDrawer();
      return;
    }
    // Focus trap: while open, Tab/Shift+Tab should cycle only through
    // the drawer's own controls, not escape into the rest of the page
    // (which a keyboard user would otherwise have to tab all the way
    // through -- header, hero, every product card -- to get back).
    if (e.key !== "Tab" || !drawer.classList.contains("open")) return;
    var focusable = drawer.querySelectorAll(
      'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable.length) return;
    var first = focusable[0],
      last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  function openWishDrawer() {
    ensureWishDrawer();
    renderWishDrawer();
    var backdrop = document.getElementById("wishBackdrop");
    if (backdrop) backdrop.classList.add("open");
    var d = document.getElementById("wishDrawer");
    d.classList.add("open");
    d.removeAttribute("inert");
    var wishToggle = document.getElementById("wishToggle");
    if (wishToggle) wishToggle.setAttribute("aria-expanded", "true");
    var closeBtn = document.getElementById("wishClose");
    if (closeBtn) closeBtn.focus();
  }
  function closeWishDrawer() {
    var b = document.getElementById("wishBackdrop"),
      d = document.getElementById("wishDrawer");
    var wasOpen = !!(d && d.classList.contains("open"));
    if (b) b.classList.remove("open");
    if (d) {
      d.classList.remove("open");
      d.setAttribute("inert", "");
    }
    var wishToggle = document.getElementById("wishToggle");
    if (wishToggle) wishToggle.setAttribute("aria-expanded", "false");
    // Setting `inert` blurs focus out from under a keyboard user if it was
    // inside the drawer (e.g. pressing Escape mid-tab) -- send it somewhere
    // sensible instead of letting it fall back to <body>. Only do this if
    // the drawer was actually open, since Escape is listened for globally.
    if (wasOpen) {
      var trigger = document.getElementById("wishToggle");
      if (trigger) trigger.focus();
    }
  }
  function renderWishDrawer() {
    var body = document.getElementById("wishBody");
    if (!body) return;
    var ids = getWishlist();
    var all = (window.YL_PRODUCTS && window.YL_PRODUCTS.products) || [];
    var items = ids
      .map(function (id) {
        return all.find(function (p) {
          return p.id === id;
        });
      })
      .filter(Boolean);
    if (!items.length) {
      body.innerHTML =
        '<div class="wish-empty"><span class="glyph" aria-hidden="true">♡</span>Nothing saved yet. Tap the heart on anything in the shop to keep it here.</div>';
      return;
    }
    body.innerHTML = items
      .map(function (p) {
        return (
          '<div class="wish-item">' +
          pictureHTML(p, { single: true, width: 64, height: 64 }) +
          '<div class="wish-item-body">' +
          "<h4>" +
          attrEsc(p.name) +
          "</h4>" +
          '<span class="price">$' +
          p.price.toFixed(2) +
          "</span>" +
          '<div class="wish-item-actions">' +
          addToCartHTML(p) +
          '<button class="wish-remove" type="button" aria-label="Remove ' +
          attrEsc(p.name) +
          ' from saved items" data-id="' +
          attrEsc(p.id) +
          '">Remove</button>' +
          "</div>" +
          "</div></div>"
        );
      })
      .join("");
  }
  document.addEventListener("click", function (e) {
    var btn = e.target.closest(".wish-btn");
    var removeBtn = e.target.closest(".wish-remove");
    if (btn) {
      e.preventDefault();
      toggleWish(btn.getAttribute("data-id"));
    } else if (removeBtn) {
      toggleWish(removeBtn.getAttribute("data-id"));
    }
  });
  initWishNavButton();

  /* ---------- Shop-card photo gallery: on-demand hydration ----------
     A slide with a data-image attribute hasn't had its real <picture>
     built yet (see cardGalleryHTML above). Building it here, the first
     time it's actually needed, is what keeps the extra photos from
     costing bandwidth on every page load. Safe to call repeatedly --
     it's a no-op once the slide's data-image attribute is gone. */
  function hydrateGallerySlide(gallery, slide) {
    if (!slide) return;
    var imgPath = slide.getAttribute("data-image");
    if (!imgPath) return;
    var productId = gallery.getAttribute("data-product-id");
    var all = (window.YL_PRODUCTS && window.YL_PRODUCTS.products) || [];
    var p = all.find(function (pr) {
      return pr.id === productId;
    });
    if (!p) return;
    // Differentiate alt text per photo (index > 0) instead of repeating
    // the product name identically on every slide -- a screen-reader
    // user stepping through the gallery dots otherwise hears the exact
    // same announcement for every photo with no way to tell them apart.
    var idx = parseInt(slide.getAttribute("data-idx"), 10);
    var total = parseInt(gallery.getAttribute("data-count"), 10);
    var alt = idx > 0 && total > 1 ? p.name + ", photo " + (idx + 1) + " of " + total : p.name;
    slide.innerHTML = pictureHTML(p, { width: 600, height: 510, imagePath: imgPath, alt: alt });
    slide.removeAttribute("data-image");
  }

  /* ---------- Premium 2026 Lightbox Modal ---------- */
  (function initLightbox() {
    var dialog = document.createElement("dialog");
    dialog.id = "imageLightboxModal";
    dialog.className = "lightbox-modal";
    dialog.setAttribute("closedby", "any");
    dialog.innerHTML =
      '<button type="button" class="lightbox-close" aria-label="Close lightbox">&times;</button>' +
      '<div class="lightbox-content">' +
      '  <button type="button" class="lightbox-prev" aria-label="Previous image">&#10094;</button>' +
      '  <img id="lightboxImage" src="" alt="Enlarged product image">' +
      '  <button type="button" class="lightbox-next" aria-label="Next image">&#10095;</button>' +
      "</div>" +
      '<div class="lightbox-dots" id="lightboxDots"></div>';
    document.body.appendChild(dialog);

    var currentImages = [];
    var currentIndex = 0;
    var imgEl = dialog.querySelector("#lightboxImage");
    var dotsContainer = dialog.querySelector("#lightboxDots");

    function showImage(idx) {
      if (idx < 0) idx = currentImages.length - 1;
      if (idx >= currentImages.length) idx = 0;
      currentIndex = idx;
      imgEl.src = currentImages[currentIndex];

      // Update dots
      var dots = dotsContainer.querySelectorAll(".lightbox-dot");
      dots.forEach(function (dot, i) {
        dot.classList.toggle("active", i === currentIndex);
      });
    }

    dialog.querySelector(".lightbox-close").addEventListener("click", function () {
      dialog.close();
    });

    dialog.querySelector(".lightbox-prev").addEventListener("click", function (e) {
      e.stopPropagation();
      showImage(currentIndex - 1);
    });

    dialog.querySelector(".lightbox-next").addEventListener("click", function (e) {
      e.stopPropagation();
      showImage(currentIndex + 1);
    });

    // Close when clicking the backdrop
    dialog.addEventListener("click", function (e) {
      var rect = dialog.getBoundingClientRect();
      var isInDialog =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      if (!isInDialog) {
        dialog.close();
      }
    });

    // Keyboard navigation (Arrow keys)
    dialog.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        showImage(currentIndex - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        showImage(currentIndex + 1);
      }
    });

    // Mobile touch swipe gestures
    var touchStartX = 0;
    var touchEndX = 0;
    dialog.addEventListener(
      "touchstart",
      function (e) {
        touchStartX = e.changedTouches[0].screenX;
      },
      { passive: true }
    );
    dialog.addEventListener(
      "touchend",
      function (e) {
        touchEndX = e.changedTouches[0].screenX;
        var diff = touchEndX - touchStartX;
        if (Math.abs(diff) > 50) {
          if (diff < 0) {
            showImage(currentIndex + 1);
          } else {
            showImage(currentIndex - 1);
          }
        }
      },
      { passive: true }
    );

    window.openLightbox = function (images, startSrc) {
      currentImages = images || [];
      var startIdx = currentImages.indexOf(startSrc);
      if (startIdx === -1) startIdx = 0;

      // Build dots
      dotsContainer.innerHTML = "";
      if (currentImages.length > 1) {
        currentImages.forEach(function (_, i) {
          var dot = document.createElement("button");
          dot.type = "button";
          dot.className = "lightbox-dot";
          dot.setAttribute("aria-label", "Go to image " + (i + 1));
          dot.addEventListener("click", function (e) {
            e.stopPropagation();
            showImage(i);
          });
          dotsContainer.appendChild(dot);
        });
        dialog.querySelector(".lightbox-prev").style.display = "flex";
        dialog.querySelector(".lightbox-next").style.display = "flex";
      } else {
        dialog.querySelector(".lightbox-prev").style.display = "none";
        dialog.querySelector(".lightbox-next").style.display = "none";
      }

      showImage(startIdx);
      dialog.showModal();
    };
  })();

  /* ---------- Shop-card photo gallery: dot clicks ----------
     Delegated so it works for cards rendered now, later (re-filtered/
     re-sorted), or added by any future page -- no per-card listener
     bookkeeping needed. */
  document.addEventListener("click", function (e) {
    var dot = e.target.closest(".card-gallery-dot");
    if (!dot) {
      if (e.target.closest(".wish-btn")) return;
      var slide = e.target.closest(".card-gallery-slide");
      if (slide) {
        var card = slide.closest(".card");
        if (card) {
          var prodId = card.getAttribute("data-id");
          if (prodId === "yallternative-gift-card") {
            return;
          }
          var allItems = ((window.YL_PRODUCTS && window.YL_PRODUCTS.products) || []).concat(
            (window.YL_PRODUCTS && window.YL_PRODUCTS.bundles) || []
          );
          var item = allItems.find(function (i) {
            return i.id === prodId;
          });
          if (item && item.images && item.images.length) {
            var activeImg = slide.querySelector("img");
            var src = activeImg ? activeImg.getAttribute("src") : item.images[0];
            window.openLightbox(item.images, src);
          }
        }
      }
      return;
    }
    var gallery = dot.closest(".card-gallery");
    if (!gallery) return;
    var idx = dot.getAttribute("data-idx");
    var targetSlide = gallery.querySelector('.card-gallery-slide[data-idx="' + idx + '"]');
    hydrateGallerySlide(gallery, targetSlide);
    gallery.querySelectorAll(".card-gallery-slide").forEach(function (slide) {
      slide.classList.toggle("active", slide.getAttribute("data-idx") === idx);
    });
    gallery.querySelectorAll(".card-gallery-dot").forEach(function (d) {
      var active = d === dot;
      d.classList.toggle("active", active);
      d.setAttribute("aria-pressed", active ? "true" : "false");
    });
  });

  /* Pre-hydrate on hover/keyboard-focus (before the click/Enter actually
     lands) so desktop users seeing the dots up close never see a blank
     flash -- mouseover/focusin both bubble, unlike mouseenter/focus, so
     one delegated listener each covers every card. Harmless no-op on
     touch devices, which just hydrate at click time above. */
  function prefetchGallerySlide(dot) {
    var gallery = dot.closest(".card-gallery");
    if (!gallery) return;
    var idx = dot.getAttribute("data-idx");
    hydrateGallerySlide(
      gallery,
      gallery.querySelector('.card-gallery-slide[data-idx="' + idx + '"]')
    );
  }
  document.addEventListener("mouseover", function (e) {
    var dot = e.target.closest(".card-gallery-dot");
    if (dot) prefetchGallerySlide(dot);
  });
  document.addEventListener("focusin", function (e) {
    var dot = e.target.closest(".card-gallery-dot");
    if (dot) prefetchGallerySlide(dot);
  });

  /* ---------- Variant picker: keep price + Add to Cart button in sync ----------
     Delegated "change" listener (change bubbles, so this covers every
     card without per-select bookkeeping). Reads the chosen <option>'s
     data-delta, adds it to the <select>'s own data-base-price, and pushes
     both the visible price and the Snipcart button's data-item-price /
     data-item-custom1-value up to date before the shopper can click
     Add to Cart. */
  document.addEventListener("change", function (e) {
    var select = e.target.closest(".variant-select");
    if (!select) return;
    var opt = select.options[select.selectedIndex];
    if (!opt) return;
    var delta = parseFloat(opt.getAttribute("data-delta")) || 0;
    var basePrice = parseFloat(select.getAttribute("data-base-price")) || 0;
    var newPrice = basePrice + delta;
    var card = select.closest(".card");
    if (!card) return;
    // Visible price only -- purely informational, shown to the shopper
    // before they click Add to Cart.
    var priceEl = card.querySelector(".card-foot .price");
    if (priceEl) priceEl.textContent = "$" + newPrice.toFixed(2);
    var addBtn = card.querySelector(".snipcart-add-item");
    if (addBtn) {
      // IMPORTANT: data-item-price must stay at the item's BASE price,
      // never basePrice + delta. Snipcart's own custom-field mechanism
      // (data-item-custom1-options, set once in addToCartHTML) already
      // encodes each option's +/- price modifier and adds it to
      // data-item-price automatically once that option is selected --
      // confirmed against Snipcart's documented pricing behavior
      // ("the final price is the sum of data-item-price and the price
      // variations of the selected options"). Bumping data-item-price
      // here too would double-charge the delta on every priced variant
      // (shea-butter 8oz, hand-scrub 4oz, either soak's 24oz, etc.) --
      // only data-item-custom1-value (which option is selected) needs
      // to change here.
      addBtn.setAttribute("data-item-custom1-value", opt.value);
    }
  });

  /* ---------- Conversion tracking (Plausible custom events) ----------
     Plausible only sees pageviews out of the box -- with no event
     tracking, there's no way to tell "people are visiting" from "people
     actually want to buy something." This fires a lightweight custom
     event on every Add to Cart click with the product name as a prop,
     so the real, once-deployed dashboard can show which products people
     are actually trying to buy, not just which pages get looked at.
     window.plausible is defined by the analytics script tag in <head>;
     guarded here since it won't exist at all when testing locally over
     file:// (no network) or for anyone running an ad/tracker blocker --
     either way this must never throw or block the actual add-to-cart. */
  document.addEventListener("click", function (e) {
    var btn = e.target.closest(".snipcart-add-item");
    if (!btn || typeof window.plausible !== "function") return;
    window.plausible("Add to Cart", {
      props: {
        product: btn.getAttribute("data-item-name") || btn.getAttribute("data-item-id") || "unknown"
      }
    });
  });
  /* The one event that actually matters more than "added to cart" is
     "paid" -- Snipcart fires cart.confirmed once an order really goes
     through. Hooking it gives a real completed-order count in Plausible
     instead of just purchase *intent*. snipcart.ready only fires once
     the Snipcart script has actually finished loading (it's lazy-loaded
     on first interaction, see loadStrategy above), so this listens for
     that first rather than assuming window.Snipcart exists yet. */
  document.addEventListener("snipcart.ready", function () {
    if (!window.Snipcart || !window.Snipcart.events) return;
    window.Snipcart.events.on("cart.confirmed", function (cart) {
      if (typeof window.plausible !== "function") return;
      window.plausible("Purchase", {
        props: {
          revenue: {
            currency: cart.currency || "USD",
            amount: cart.total || 0
          }
        }
      });
    });
  });

  /* ---------- Tag pills HTML ---------- */
  var TAG_LABELS = {
    vegan:
      '<svg viewBox="0 0 340 362" width="12" height="12" fill="currentColor"><g transform="matrix(0.1,0,0,-0.1,0,362)"><path d="m 3190,3550 c -80,-21 -249,-59 -375,-84 -321,-63 -372,-82 -515,-188 -203,-151 -345,-443 -344,-708 1,-101 16,-173 33,-154 4,5 18,34 30,64 61,147 238,371 389,492 77,62 232,123 232,91 0,-11 -53,-77 -116,-143 -59,-63 -79,-89 -190,-250 -115,-169 -265,-471 -366,-740 -98,-261 -170,-469 -218,-625 -81,-267 -154,-478 -167,-482 -16,-6 -60,137 -152,492 -143,556 -204,747 -350,1095 -100,237 -232,427 -500,718 -147,161 -356,315 -482,357 -82,28 -89,14 -27,-55 292,-329 461,-573 640,-920 151,-295 255,-588 444,-1260 48,-172 154,-610 188,-780 38,-189 80,-374 91,-403 4,-9 19,-21 34,-25 34,-9 198,-9 233,0 52,15 62,56 134,528 48,319 89,510 171,795 139,486 287,842 377,900 13,8 77,24 144,35 260,43 469,158 617,341 99,122 125,212 150,512 13,159 21,204 51,299 19,62 32,118 30,125 -7,18 -23,16 -186,-27 z"/></g></svg>Vegan',
    unscented:
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/></svg>Unscented',
    "essential-oil-free":
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/></svg>EO-Free',
    "sensitive-safe":
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>Sensitive Safe',
    "cruelty-free":
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>Cruelty-Free',
    organic:
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 3.5 1 9.8a7 7 0 0 1-9 8.2Z"/><path d="M19 2c-2.26 4.33-5.27 7.14-8 10"/></svg>Organic',
    "locally-sourced":
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>Locally Sourced'
  };
  function tagPillsHTML(p) {
    var tags = p.tags;
    if (!tags || !tags.length) return "";
    return (
      '<div class="tag-pills">' +
      tags
        .map(function (t) {
          return '<span class="tag-pill">' + (TAG_LABELS[t] || t) + "</span>";
        })
        .join("") +
      "</div>"
    );
  }

  /* ---------- Shop: render products from products.json + filter/sort ---------- */
  var shopGrid = document.getElementById("shopGrid");
  var featuredGrid = document.getElementById("featuredGrid");
  var filterRow = document.getElementById("filterRow");
  var sortSelect = document.getElementById("sortSelect");
  var shopCount = document.getElementById("shopCount");
  var shopSearch = document.getElementById("shopSearch");

  if (shopGrid || featuredGrid) {
    // Data ships as a plain <script> global (assets/js/products-data.js),
    // not a fetch() of JSON -- so the catalog renders instantly whether
    // the site is opened straight off disk (file://) or from a live host.
    var data = window.YL_PRODUCTS;
    if (data) {
      // Not eager here -- the homepage's own hero image is the real LCP
      // element and already carries its own preload + fetchpriority=high;
      // eagerly loading featured-grid photos too would just compete with
      // it for bandwidth at the moment that matters most.
      if (featuredGrid)
        renderCards(featuredGrid, pickFeatured(data.products), { eagerFirst: false });
      if (shopGrid) {
        if (filterRow) {
          buildFilters(
            filterRow,
            data.categories,
            shopGrid,
            data.products,
            sortSelect,
            shopCount,
            shopSearch
          );
        } else {
          renderCards(shopGrid, data.products);
        }
      }
      renderBundles(data);

      fetch("/.netlify/functions/inventory")
        .then(function (res) {
          if (!res.ok) throw new Error("Status " + res.status);
          return res.json();
        })
        .then(function (stockData) {
          if (!stockData || typeof stockData !== "object" || Object.keys(stockData).length === 0)
            return;
          var hasChanges = false;
          data.products.forEach(function (p) {
            if (stockData[p.id] !== undefined) {
              var newStock = Number(stockData[p.id]);
              if (p.stock !== newStock) {
                p.stock = newStock;
                hasChanges = true;
              }
            }
          });
          if (hasChanges) {
            console.log("[inventory] Live stock levels updated. Re-rendering.");
            if (sortSelect) {
              sortSelect.dispatchEvent(new Event("change"));
            } else if (shopGrid && !filterRow) {
              renderCards(shopGrid, data.products);
            }
            if (featuredGrid) {
              renderCards(featuredGrid, pickFeatured(data.products), { eagerFirst: false });
            }
          }
        })
        .catch(function (err) {
          console.warn("[inventory] Could not fetch live stock levels:", err);
        });
    } else {
      console.warn("Product data (assets/js/products-data.js) did not load.");
    }
  }

  /* Sort is independent of category -- applied after filtering, never
     instead of it. "featured" keeps the catalog's own listed order. */
  function sortProducts(list, mode) {
    var arr = list.slice();
    if (mode === "price-asc")
      arr.sort(function (a, b) {
        return a.price - b.price;
      });
    else if (mode === "price-desc")
      arr.sort(function (a, b) {
        return b.price - a.price;
      });
    else if (mode === "name-asc")
      arr.sort(function (a, b) {
        return a.name.localeCompare(b.name);
      });
    return arr;
  }

  function pickFeatured(products) {
    return products.filter(function (p) {
      return p.featured === true;
    });
  }

  /* ---------- Bundles / gift sets (shop.html only) ----------
     Real component products at a computed discount -- see products-data.js
     "bundles" array for the full rationale. Each bundle checks out as its
     own single Snipcart line item (id "bundle-<id>"), priced by
     scripts/build-site-data.js from the same real product prices this
     function reads, so the on-page math and the checkout price can never
     disagree. */
  function bundlesHTML(bundles, productsById) {
    return bundles
      .map(function (b) {
        var items = b.productIds
          .map(function (id) {
            return productsById[id];
          })
          .filter(Boolean);
        if (items.length !== b.productIds.length) return ""; // a referenced product went missing -- skip rather than show a broken card
        var fullPrice = items.reduce(function (sum, p) {
          var original = p.originalPrice || p.price;
          return sum + original;
        }, 0);
        var bundlePrice = Math.round(fullPrice * (1 - (b.discountPercent || 0) / 100) * 100) / 100;
        var firstImage = items[0].image;
        var includesList = items
          .map(function (p) {
            return "<li>" + attrEsc(p.name) + "</li>";
          })
          .join("");
        return (
          '<article class="card bundle-card reveal">' +
          '<div class="card-media">' +
          pictureHTML(items[0], { imagePath: firstImage, alt: b.name }) +
          "</div>" +
          '<div class="card-body">' +
          '<span class="card-cat">Gift Set</span>' +
          "<h3>" +
          attrEsc(b.name) +
          "</h3>" +
          "<p>" +
          attrEsc(b.blurb) +
          "</p>" +
          '<ul class="bundle-includes">' +
          includesList +
          "</ul>" +
          '<div class="card-foot">' +
          '<div class="card-foot-row">' +
          '<span class="price">$' +
          bundlePrice.toFixed(2) +
          ' <s class="bundle-full-price">$' +
          fullPrice.toFixed(2) +
          "</s></span>" +
          '<button type="button" class="btn btn-primary btn-sm snipcart-add-item"' +
          ' data-item-id="bundle-' +
          attrEsc(b.id) +
          '"' +
          ' data-item-name="' +
          attrEsc(b.name) +
          '"' +
          ' data-item-price="' +
          bundlePrice.toFixed(2) +
          '"' +
          ' data-item-url="/assets/data/snipcart-products.json"' +
          ' data-item-description="' +
          attrEsc(b.blurb) +
          '"' +
          ' data-item-image="' +
          attrEsc(firstImage) +
          '"' +
          ' data-item-categories="bundle">' +
          "Add Set to Cart" +
          "</button>" +
          "</div>" +
          "</div>" +
          "</div>" +
          "</article>"
        );
      })
      .join("");
  }

  function renderBundles(data, query) {
    var bundlesList = document.getElementById("bundlesList");
    var bundlesSection = document.querySelector(".bundles-section");
    if (!bundlesList) return;
    if (!data.bundles || !data.bundles.length) {
      if (bundlesSection) bundlesSection.style.display = "none";
      return;
    }
    var productsById = {};
    data.products.forEach(function (p) {
      productsById[p.id] = p;
    });
    var q = (query || "").trim().toLowerCase();
    var filteredBundles = data.bundles.filter(function (b) {
      if (!q) return true;
      var haystack = (
        b.name +
        " " +
        b.blurb +
        " " +
        b.productIds
          .map(function (id) {
            return productsById[id] ? productsById[id].name : "";
          })
          .join(" ")
      ).toLowerCase();
      return haystack.indexOf(q) !== -1;
    });

    if (!filteredBundles.length) {
      if (bundlesSection) bundlesSection.style.display = "none";
      return;
    }

    if (bundlesSection) bundlesSection.style.display = "";
    bundlesList.innerHTML = bundlesHTML(filteredBundles, productsById);
    wireReveal(bundlesList);
  }

  /* Only rendered for products carrying real per-listing Etsy review data
     (products-data.js's p.rating, kept in sync by scripts/apply-etsy-
     snapshot.js) -- never a fabricated or shop-wide number. Visual stars
     are aria-hidden with a proper sr-only equivalent, same pattern used
     for the testimonial stars on index.html and the shop-page trust line. */
  function ratingHTML(p) {
    if (!p.rating || !(p.rating.count >= 3)) return "";
    var full = Math.max(0, Math.min(5, Math.round(p.rating.value)));
    var stars = "";
    for (var i = 0; i < 5; i++) stars += i < full ? "★" : "☆";
    var reviewWord = p.rating.count === 1 ? "review" : "reviews";
    return (
      '<div class="card-rating">' +
      '<span aria-hidden="true">' +
      stars +
      "</span>" +
      '<span class="sr-only">Rated ' +
      p.rating.value.toFixed(1) +
      " out of 5 stars, " +
      p.rating.count +
      " " +
      reviewWord +
      "</span>" +
      "</div>"
    );
  }

  /* Real, per-product ingredient/materials lists -- gathered from each
     listing's own Etsy description (never the generic reused "Materials"
     tag alone, which turned out to be copy-pasted boilerplate across a
     few unrelated listings; see products-data.js entries for the
     product-specific source used instead). Rendered collapsed by
     default via <details> so it adds real value without bloating every
     card -- only shoppers who want to check for an allergen expand it. */
  function ingredientsHTML(p) {
    if (!p.ingredients || !p.ingredients.length) return "";
    var label = p.ingredientsLabel || "Ingredients";
    var items = p.ingredients
      .map(function (i) {
        return "<li>" + attrEsc(i) + "</li>";
      })
      .join("");
    var note = p.ingredientsNote
      ? '<p class="ingredients-note">' + attrEsc(p.ingredientsNote) + "</p>"
      : "";
    return (
      '<details class="card-ingredients">' +
      "<summary>" +
      attrEsc(label) +
      "</summary>" +
      "<ul>" +
      items +
      "</ul>" +
      note +
      '<p class="ingredients-caveat">Have a sensitivity or allergy? Double-check this list before use, and message us with any questions.</p>' +
      "</details>"
    );
  }

  function cardHTML(p, opts) {
    opts = opts || {};
    var catLabel =
      {
        apparel: "Apparel",
        salves: "Salves & Balms",
        body: "Body & Skin",
        soaks: "Soaks",
        potions: "Potions & Spellwork",
        ritual: "Ritual & Home",
        "gift-cards": "Gift Cards"
      }[p.category] || p.category;
    var wished = isWished(p.id);
    return (
      '<article class="card reveal" data-id="' +
      attrEsc(p.id) +
      '" data-category="' +
      attrEsc(p.category) +
      '">' +
      '<div class="card-media">' +
      cardGalleryHTML(p, { eager: !!opts.eager }) +
      '<button class="wish-btn' +
      (wished ? " active" : "") +
      '" type="button" data-id="' +
      attrEsc(p.id) +
      '" aria-pressed="' +
      (wished ? "true" : "false") +
      '" aria-label="' +
      (wished
        ? "Remove " + attrEsc(p.name) + " from saved items"
        : "Save " + attrEsc(p.name) + " for later") +
      '">' +
      wishHeartSVG +
      "</button>" +
      "</div>" +
      '<div class="card-body">' +
      '<span class="card-cat">' +
      catLabel +
      "</span>" +
      tagPillsHTML(p) +
      "<h3>" +
      attrEsc(p.name) +
      "</h3>" +
      ratingHTML(p) +
      "<p>" +
      attrEsc(p.blurb) +
      "</p>" +
      ingredientsHTML(p) +
      stockBadgeHTML(p) +
      '<div class="card-foot">' +
      variantSelectHTML(p) +
      (p.id !== "yallternative-gift-card"
        ? '<p style="font-size: 0.72rem; color: var(--whiskey); margin: 0 0 10px 0; text-align: center; font-weight: 600;">Free shipping over $40</p>'
        : "") +
      '<div class="card-foot-row">' +
      '<span class="price">$' +
      p.price.toFixed(2) +
      "</span>" +
      addToCartHTML(p) +
      "</div>" +
      "</div>" +
      "</div>" +
      "</article>"
    );
  }

  /* First-4-cards-eager applies only when the grid is showing its default,
     unfiltered order (state.filter === "all" in buildFilters, or the plain
     renderCards(shopGrid, data.products) call with no filter UI at all) --
     that's the only time "first N cards" reliably means "the ones actually
     above the fold on initial load." A filtered/sorted re-render already
     happened after a deliberate user interaction, well after LCP, so it
     always renders lazy. */
  var EAGER_CARD_COUNT = 4;
  function renderCards(container, products, opts) {
    opts = opts || {};
    var eagerFirst = opts.eagerFirst !== false;
    container.innerHTML = products
      .map(function (p, i) {
        return cardHTML(p, { eager: eagerFirst && i < EAGER_CARD_COUNT });
      })
      .join("");
    wireReveal(container);
  }

  /* ---------- Site-submitted customer reviews (shop.html only) ----------
     Renders window.YL_SITE_REVIEWS (assets/js/site-reviews-data.js) --
     hand-curated by Savanna after reading a Formspree submission email,
     completely separate from products-data.js's Etsy-sourced `rating`
     field. Guarded by #siteReviewsList existing at all, so this is a
     no-op on every page except shop.html. */
  var siteReviewsList = document.getElementById("siteReviewsList");
  if (siteReviewsList) {
    var productsById = {};
    ((window.YL_PRODUCTS && window.YL_PRODUCTS.products) || []).forEach(function (p) {
      productsById[p.id] = p;
    });

    function formatReviewDate(iso) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return "";
      var d = new Date(iso + "T00:00:00");
      return isNaN(d.getTime())
        ? ""
        : d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    }

    var siteReviews = (window.YL_SITE_REVIEWS || []).slice().sort(function (a, b) {
      return (b.date || "").localeCompare(a.date || "");
    });
    if (siteReviews.length) {
      siteReviewsList.innerHTML = siteReviews
        .map(function (r) {
          var product = r.productId && productsById[r.productId];
          var full = Math.max(0, Math.min(5, Math.round(r.rating)));
          var stars = "";
          for (var i = 0; i < 5; i++) stars += i < full ? "★" : "☆";
          var byline =
            attrEsc(r.name || "A customer") +
            (product ? " · " + attrEsc(product.name) : "") +
            (r.date ? " · " + formatReviewDate(r.date) : "");
          return (
            '<div class="quote-card review-card reveal">' +
            '<span class="stars" aria-hidden="true">' +
            stars +
            "</span>" +
            '<span class="sr-only">Rated ' +
            attrEsc(r.rating) +
            " out of 5 stars.</span>" +
            "<p>&ldquo;" +
            attrEsc(r.text) +
            "&rdquo;</p>" +
            "<footer>" +
            byline +
            "</footer>" +
            "</div>"
          );
        })
        .join("");
      wireReveal(siteReviewsList);
      var emptyMsg = document.getElementById("siteReviewsEmpty");
      if (emptyMsg) emptyMsg.style.display = "none";
    }

    // Product picker: a static "General / whole shop" option already
    // lives in the HTML (so the field still works with JS off, just
    // without per-product choices); this appends the real catalog.
    var reviewProductSelect = document.getElementById("review_product");
    if (reviewProductSelect && window.YL_PRODUCTS && window.YL_PRODUCTS.products) {
      window.YL_PRODUCTS.products.forEach(function (p) {
        var opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        reviewProductSelect.appendChild(opt);
      });
    }
  }

  /* ---------- Events page: render from events-data.js ---------- */
  var upcomingEl = document.getElementById("upcomingEvents");
  var pastEl = document.getElementById("pastEvents");

  if (upcomingEl || pastEl) {
    var events = window.YL_EVENTS || { upcoming: [], past: [] };
    var rawUpcoming = events.upcoming || [];
    var rawPast = events.past || [];
    var todayStr = new Date().toISOString().slice(0, 10);

    var upcoming = [];
    var past = [];

    // Auto-promote upcoming events in the past to the past array
    rawUpcoming.forEach(function (ev) {
      if (ev.date && ev.date < todayStr) {
        past.push(ev);
      } else {
        upcoming.push(ev);
      }
    });

    rawPast.forEach(function (ev) {
      past.push(ev);
    });

    if (upcomingEl) {
      var sortedUpcoming = upcoming.slice().sort(function (a, b) {
        return new Date(a.date) - new Date(b.date);
      });
      if (sortedUpcoming.length) {
        upcomingEl.innerHTML = sortedUpcoming.map(eventCardHTML).join("");
      } else {
        upcomingEl.innerHTML =
          '<div class="event-empty reveal">' +
          '<span class="glyph" aria-hidden="true">✦</span>' +
          "<h3>New Pop-Ups Land Here As Soon As They're Booked</h3>" +
          "<p>We keep this page current the second a market or Pride date is locked in. In the meantime, " +
          "follow along on Instagram or TikTok where every table gets announced first.</p>" +
          '<div class="hero-actions" style="justify-content:center;">' +
          '<a class="btn btn-primary" href="https://www.instagram.com/yallternativeliving" target="_blank" rel="noopener">Instagram ↗<span class="sr-only">(opens in new tab)</span></a>' +
          '<a class="btn btn-outline" href="https://www.tiktok.com/@yallternativeliving" target="_blank" rel="noopener">TikTok ↗<span class="sr-only">(opens in new tab)</span></a>' +
          "</div>" +
          "</div>";
      }
      markReveal(upcomingEl);
    }

    if (pastEl) {
      // Sort past events: most recent first
      var sortedPast = past.slice().sort(function (a, b) {
        var dateA = a.date || "1970-01-01";
        var dateB = b.date || "1970-01-01";
        return new Date(dateB) - new Date(dateA);
      });

      function renderPastEventsCarousel() {
        // Slice to top 3 most recent appearances
        var displayPast = sortedPast.slice(0, 3);

        if (displayPast.length) {
          pastEl.innerHTML =
            '<div class="events-carousel-inner">' +
            displayPast
              .map(function (ev, index) {
                var cardHtml = eventCardHTML(ev);
                if (index === 0) {
                  return cardHtml.replace(
                    'class="card event-card reveal"',
                    'class="card event-card active"'
                  );
                } else {
                  return cardHtml.replace(
                    'class="card event-card reveal"',
                    'class="card event-card"'
                  );
                }
              })
              .join("") +
            "</div>" +
            '<button class="carousel-arrow carousel-prev" aria-label="Previous appearance">&#8249;</button>' +
            '<button class="carousel-arrow carousel-next" aria-label="Next appearance">&#8250;</button>' +
            '<div class="carousel-dots">' +
            displayPast
              .map(function (_, i) {
                return (
                  '<button class="carousel-dot' +
                  (i === 0 ? " active" : "") +
                  '" aria-label="Go to slide ' +
                  (i + 1) +
                  '" data-index="' +
                  i +
                  '"></button>'
                );
              })
              .join("") +
            "</div>";

          if (sortedPast.length > 3) {
            var btnContainer = document.createElement("div");
            btnContainer.className = "past-events-footer";
            btnContainer.style.textAlign = "center";
            btnContainer.style.marginTop = "32px";
            btnContainer.innerHTML =
              '<button class="btn btn-outline btn-sm" id="toggleAllPastEvents">See All Past Pop-ups (' +
              sortedPast.length +
              ")</button>";
            pastEl.appendChild(btnContainer);

            btnContainer
              .querySelector("#toggleAllPastEvents")
              .addEventListener("click", function () {
                // Destroy carousel layout and replace with full grid
                pastEl.innerHTML =
                  '<div class="grid grid-3">' +
                  sortedPast
                    .map(function (ev) {
                      return eventCardHTML(ev);
                    })
                    .join("") +
                  "</div>" +
                  '<div class="past-events-footer" style="text-align:center; margin-top:32px;">' +
                  '<button class="btn btn-outline btn-sm" id="toggleAllPastEvents">Show Carousel</button>' +
                  "</div>";

                // Bind event to go back to carousel
                pastEl.querySelector("#toggleAllPastEvents").addEventListener("click", function () {
                  renderPastEventsCarousel();
                });

                // Wire up scroll reveal for the new grid cards
                wireReveal(pastEl);
              });
          }

          setupPastEventsRotation(pastEl);
        } else {
          pastEl.innerHTML =
            '<p class="muted center">No past pop-ups logged yet. Check back soon.</p>';
        }
        markReveal(pastEl);
      }

      renderPastEventsCarousel();
    }
  }

  function setupPastEventsRotation(container) {
    var inner = container.querySelector(".events-carousel-inner");
    var cards = container.querySelectorAll(".event-card");
    var dots = container.querySelectorAll(".carousel-dot");
    if (!inner || cards.length <= 1) return;
    var currentIndex = 0;
    var paused = false;
    var intervalId;
    var mql = window.matchMedia("(max-width: 768px)");

    function goTo(index) {
      if (!container.querySelector(".events-carousel-inner")) return;
      cards[currentIndex].classList.remove("active");
      if (dots[currentIndex]) dots[currentIndex].classList.remove("active");
      currentIndex = ((index % cards.length) + cards.length) % cards.length;
      cards[currentIndex].classList.add("active");
      if (dots[currentIndex]) dots[currentIndex].classList.add("active");
      inner.style.transform = "translateX(-" + currentIndex * 100 + "%)";
    }

    function stopAutoplay() {
      clearInterval(intervalId);
      intervalId = null;
    }

    function startAutoplay() {
      stopAutoplay();
      intervalId = setInterval(function () {
        // Self-clean if the carousel was destroyed (e.g. toggled to grid)
        if (!container.querySelector(".events-carousel-inner")) {
          stopAutoplay();
          return;
        }
        if (!paused) goTo(currentIndex + 1);
      }, 4000);
    }

    function enterCarouselMode() {
      currentIndex = 0;
      inner.style.transform = "translateX(0)";
      for (var i = 0; i < cards.length; i++) cards[i].classList.remove("active");
      cards[0].classList.add("active");
      for (var j = 0; j < dots.length; j++) dots[j].classList.remove("active");
      if (dots[0]) dots[0].classList.add("active");
      startAutoplay();
    }

    function exitCarouselMode() {
      stopAutoplay();
      inner.style.transform = "";
      for (var i = 0; i < cards.length; i++) cards[i].classList.remove("active");
    }

    // Respond to viewport changes
    function onViewportChange() {
      if (mql.matches) {
        enterCarouselMode();
      } else {
        exitCarouselMode();
      }
    }
    mql.addEventListener("change", onViewportChange);

    // Pause on hover / focus
    container.addEventListener("mouseenter", function () {
      paused = true;
    });
    container.addEventListener("mouseleave", function () {
      paused = false;
    });
    container.addEventListener("focusin", function () {
      paused = true;
    });
    container.addEventListener("focusout", function () {
      paused = false;
    });

    // Arrow controls
    var prev = container.querySelector(".carousel-prev");
    var next = container.querySelector(".carousel-next");
    if (prev)
      prev.addEventListener("click", function () {
        goTo(currentIndex - 1);
        startAutoplay();
      });
    if (next)
      next.addEventListener("click", function () {
        goTo(currentIndex + 1);
        startAutoplay();
      });

    // Dot controls
    dots.forEach(function (dot) {
      dot.addEventListener("click", function () {
        goTo(parseInt(this.getAttribute("data-index"), 10));
        startAutoplay();
      });
    });

    // Touch swipe gesture controls for mobile users
    var touchStartX = 0;
    var touchEndX = 0;
    inner.addEventListener(
      "touchstart",
      function (e) {
        touchStartX = e.changedTouches[0].screenX;
      },
      { passive: true }
    );
    inner.addEventListener(
      "touchend",
      function (e) {
        touchEndX = e.changedTouches[0].screenX;
        var diff = touchEndX - touchStartX;
        if (Math.abs(diff) > 50) {
          // threshold of 50px
          if (diff < 0) {
            goTo(currentIndex + 1); // swipe left
          } else {
            goTo(currentIndex - 1); // swipe right
          }
          startAutoplay();
        }
      },
      { passive: true }
    );

    // Initial setup based on current viewport
    if (mql.matches) {
      enterCarouselMode();
    }
  }

  function eventCardHTML(ev) {
    return (
      '<article class="card event-card reveal">' +
      '<div class="card-body">' +
      '<span class="card-cat">' +
      attrEsc(ev.type) +
      "</span>" +
      "<h3>" +
      attrEsc(ev.name) +
      "</h3>" +
      '<p class="event-date"><time datetime="' +
      (attrEsc(ev.date) || "") +
      '">' +
      "📅 " +
      attrEsc(ev.dateLabel) +
      "</time></p>" +
      '<p class="event-location">' +
      (ev.location ? "📍 " + attrEsc(ev.location) : "") +
      "</p>" +
      (ev.note ? '<p class="event-desc">' + attrEsc(ev.note) + "</p>" : "") +
      '<div class="event-cta">' +
      (ev.url
        ? '<a class="btn btn-primary btn-sm btn-block" href="' +
          attrEsc(ev.url) +
          '" target="_blank" rel="noopener">More Info / RSVP<span class="sr-only">(opens in new tab)</span></a>'
        : "") +
      "</div>" +
      "</div>" +
      "</article>"
    );
  }

  function markReveal(container) {
    wireReveal(container);
  }

  function buildFilters(row, categories, grid, allProducts, sortSelect, countEl, searchInput) {
    var pills = [
      '<button class="filter-pill active" type="button" data-filter="all" aria-pressed="true">All</button>'
    ].concat(
      categories.map(function (c) {
        return (
          '<button class="filter-pill" type="button" data-filter="' +
          attrEsc(c.id) +
          '" aria-pressed="false">' +
          attrEsc(c.label) +
          "</button>"
        );
      })
    );
    row.innerHTML = pills.join("");

    var catLabel = {};
    categories.forEach(function (c) {
      catLabel[c.id] = c.label;
    });
    var state = { filter: "all", sort: sortSelect ? sortSelect.value : "featured", query: "" };
    // Only the very first render of this grid can plausibly be showing
    // cards that are actually above the fold on initial page load -- every
    // render after that was triggered by a deliberate filter/sort click,
    // well after LCP, so it should always load lazily.
    var isFirstRender = true;

    // Plain client-side substring search across name/blurb/category label --
    // 13 products is nowhere near enough to need a search index or a
    // library; a straight .filter() re-runs in well under a millisecond.
    function matchesQuery(p, q) {
      if (!q) return true;
      var haystack = (
        p.name +
        " " +
        p.blurb +
        " " +
        (catLabel[p.category] || p.category)
      ).toLowerCase();
      return haystack.indexOf(q) !== -1;
    }

    function render() {
      var productsById = {};
      allProducts.forEach(function (p) {
        productsById[p.id] = p;
      });

      var q = state.query.trim().toLowerCase();
      var bundlesSection = document.querySelector(".bundles-section");

      if (state.filter === "gift-sets") {
        var filteredBundles = (window.YL_PRODUCTS.bundles || []).filter(function (b) {
          if (!q) return true;
          var haystack = (
            b.name +
            " " +
            b.blurb +
            " " +
            b.productIds
              .map(function (id) {
                return productsById[id] ? productsById[id].name : "";
              })
              .join(" ")
          ).toLowerCase();
          return haystack.indexOf(q) !== -1;
        });

        grid.innerHTML = bundlesHTML(filteredBundles, productsById);
        wireReveal(grid);

        if (bundlesSection) bundlesSection.style.display = "none";

        if (countEl) {
          if (!filteredBundles.length) {
            countEl.textContent =
              "No gift sets match" +
              (q ? ' "' + state.query.trim() + '"' : " that search") +
              " -- try a different word or clear the search.";
          } else {
            countEl.textContent =
              "Showing " +
              filteredBundles.length +
              " of " +
              window.YL_PRODUCTS.bundles.length +
              " gift sets";
          }
        }
      } else {
        var filtered =
          state.filter === "all"
            ? allProducts
            : allProducts.filter(function (p) {
                return p.category === state.filter;
              });

        filtered = filtered.filter(function (p) {
          return matchesQuery(p, q);
        });

        var sorted = sortProducts(filtered, state.sort);
        renderCards(grid, sorted, { eagerFirst: isFirstRender });
        isFirstRender = false;

        if (state.filter === "all") {
          renderBundles(window.YL_PRODUCTS, q);
        } else {
          if (bundlesSection) bundlesSection.style.display = "none";
        }

        if (countEl) {
          if (!sorted.length) {
            countEl.textContent =
              "No goods match" +
              (q ? ' "' + state.query.trim() + '"' : " that search") +
              " -- try a different word or clear the search.";
          } else {
            var label = state.filter === "all" ? "goods" : catLabel[state.filter] || "goods";
            countEl.textContent =
              "Showing " + sorted.length + " of " + allProducts.length + " " + label.toLowerCase();
          }
        }
      }
      var eyebrowProductCount = document.getElementById("eyebrowProductCount");
      if (eyebrowProductCount) {
        var activeHandmade = allProducts.filter(function (p) {
          return !p.comingSoon && p.id !== "yallternative-gift-card";
        }).length;
        eyebrowProductCount.textContent = activeHandmade;
      }
    }

    row.addEventListener("click", function (e) {
      var btn = e.target.closest(".filter-pill");
      if (!btn) return;
      row.querySelectorAll(".filter-pill").forEach(function (b) {
        var isActive = b === btn;
        b.classList.toggle("active", isActive);
        b.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
      state.filter = btn.getAttribute("data-filter");
      render();
    });

    if (sortSelect) {
      sortSelect.addEventListener("change", function () {
        state.sort = sortSelect.value;
        render();
      });
    }

    if (searchInput) {
      // Light debounce -- purely a courtesy against re-rendering on every
      // keystroke of a fast typist; at 13 products it's imperceptible
      // either way, but it's free and it's the right habit.
      var debounceTimer;
      var analyticsTimer;
      var lastTrackedQuery = "";
      searchInput.addEventListener("input", function () {
        clearTimeout(debounceTimer);
        clearTimeout(analyticsTimer);
        var value = searchInput.value;

        // Fast debounce for UI updates
        debounceTimer = setTimeout(function () {
          state.query = value;
          render();
        }, 150);

        // Slow debounce for analytics (wait until they finish typing)
        analyticsTimer = setTimeout(function () {
          if (
            value.trim().length > 2 &&
            value !== lastTrackedQuery &&
            typeof window.plausible === "function"
          ) {
            window.plausible("Site Search", { props: { query: value.trim() } });
            lastTrackedQuery = value;
          }
        }, 1500);
      });
      searchInput.addEventListener("search", function () {
        clearTimeout(debounceTimer);
        state.query = searchInput.value;
        render();
      });
      var searchForm = document.getElementById("shopSearchForm");
      if (searchForm) {
        searchForm.addEventListener("submit", function (e) {
          e.preventDefault();
          // For WebMCP agents: respond immediately with the filtered state
          if (e.agentInvoked && typeof e.respondWith === "function") {
            e.respondWith(
              Promise.resolve(
                "Search complete. The shop catalog is now filtered to show matching products."
              )
            );
          }
        });
      }
    }

    // Deep-linking: footer links like shop.html#apparel pre-select that filter.
    var hash = window.location.hash.replace("#", "");
    if (
      hash &&
      categories.some(function (c) {
        return c.id === hash;
      })
    ) {
      state.filter = hash;
      row.querySelectorAll(".filter-pill").forEach(function (b) {
        var isActive = b.getAttribute("data-filter") === hash;
        b.classList.toggle("active", isActive);
        b.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
    }

    render();
  }

  /* ---------- Snipcart load-failure fallback ----------
     Checkout is a client-side script from cdn.snipcart.com, loaded
     lazily on the first cart interaction (loadStrategy:
     "on-user-interaction"). If an aggressive ad/tracker blocker or a
     CDN outage stops it loading, a shopper could click "Add to Cart"
     and get nothing -- a silent dead end and a lost sale. This watches
     for exactly that: on the first cart interaction, it waits a few
     seconds for window.Snipcart to come alive; if it never does, it
     reveals a small, dismissible bar pointing at the Etsy shop (a real,
     always-available second sales channel every product already links
     to) so the sale isn't simply lost. Purely additive -- it never
     touches or blocks Snipcart's own behavior, so when Snipcart loads
     normally (the overwhelming majority of visits) this does nothing at
     all. */
  (function snipcartFallback() {
    var ETSY_SHOP = "https://www.etsy.com/shop/YallternativeLivinCO";
    var armed = false;
    var barShown = false;
    var bar = null;
    var watchIv = null;

    function snipcartAlive() {
      // "#snipcart[hidden=false]" (the old second clause here) can never
      // match -- the hidden attribute reflects as present/absent, never
      // the literal string "false" -- so window.Snipcart plus a check for
      // Snipcart's populated cart DOM are the two real signals.
      return !!(window.Snipcart || document.querySelector("#snipcart .snipcart-cart"));
    }

    function hideFallbackBar() {
      if (bar) {
        bar.remove();
        bar = null;
      }
      barShown = false;
    }

    function showFallbackBar() {
      if (barShown) return;
      barShown = true;
      bar = document.createElement("div");
      bar.className = "cart-fallback";
      bar.setAttribute("role", "alert");
      bar.innerHTML =
        "<p>Checkout didn't load. An ad or tracker blocker can sometimes stop it. " +
        'You can still grab everything on our <a href="' +
        ETSY_SHOP +
        '" target="_blank" rel="noopener">Etsy shop<span class="sr-only">(opens in new tab)</span></a>.</p>' +
        '<button type="button" class="cart-fallback-close" aria-label="Dismiss">&times;</button>';
      bar.querySelector(".cart-fallback-close").addEventListener("click", hideFallbackBar);
      document.body.appendChild(bar);

      // Snipcart can still finish loading late (slow connection, a
      // retried request) even after we've given up and shown this bar.
      // Keep a light watch running so it disappears the moment Snipcart
      // does come alive, instead of leaving a stale "checkout is broken"
      // message sitting next to a cart that now works fine.
      var watched = 0;
      watchIv = setInterval(function () {
        watched += 2000;
        if (snipcartAlive()) {
          clearInterval(watchIv);
          hideFallbackBar();
          return;
        }
        if (watched >= 120000) clearInterval(watchIv); // stop watching after 2min
      }, 2000);
    }

    function arm() {
      if (armed) return;
      armed = true;
      var waited = 0;
      // Snipcart's own script starts downloading on this exact same
      // click -- it gets no head start over this watcher -- so a short
      // timeout here mostly just flags normal load latency as "broken."
      // 15s gives slower connections real room before we assume Snipcart
      // actually failed rather than just being slow.
      var iv = setInterval(function () {
        waited += 500;
        if (snipcartAlive()) {
          clearInterval(iv);
          return; // loaded fine -- nothing to do
        }
        if (waited >= 15000) {
          clearInterval(iv);
          if (!snipcartAlive()) showFallbackBar();
        }
      }, 500);
    }

    // Capture phase so this runs regardless of Snipcart's own handlers;
    // we never preventDefault, so a working Snipcart proceeds untouched.
    document.addEventListener(
      "click",
      function (e) {
        var t = e.target;
        if (t && t.closest && t.closest(".snipcart-add-item, .snipcart-checkout")) arm();
      },
      true
    );
  })();

  /* ---------- Announcement bar: free shipping threshold ---------- */
  (function announcementBar() {
    var data = window.YL_PRODUCTS;
    if (!data || !data.shop) return;
    var threshold = data.shop.freeShippingThreshold;
    if (!threshold || threshold <= 0) return;
    var bar = document.createElement("div");
    bar.className = "announcement-bar";
    bar.setAttribute("role", "status");
    bar.textContent = "✦ Free shipping on orders over $" + threshold + " ✦";
    document.body.insertBefore(bar, document.body.firstChild);
  })();

  /* ---------- Snipcart cart drawer: shipping progress + cross-sell ---------- */
  (function snipcartCartEnhancements() {
    var data = window.YL_PRODUCTS;
    if (!data || !data.shop) return;
    var threshold = data.shop.freeShippingThreshold || 0;
    var products = data.products || [];

    // ⚡ Bolt: Pre-sort the cross-sell products list once during init instead of on every cart render
    var sortedCrossSellCandidates = products.slice().sort(function (a, b) {
      return a.price - b.price;
    });

    function buildProgressHTML(total) {
      if (threshold <= 0) return "";
      var pct = Math.min(100, Math.round((total / threshold) * 100));
      var remaining = threshold - total;
      if (remaining <= 0) {
        return (
          '<div class="shipping-progress shipping-progress--done">' +
          "🎉 You've unlocked free shipping!" +
          "</div>"
        );
      }
      return (
        '<div class="shipping-progress">' +
        "You're <strong>$" +
        remaining.toFixed(2) +
        "</strong> away from free shipping!" +
        '<div class="shipping-progress__bar">' +
        '<div class="shipping-progress__fill" style="width:' +
        pct +
        '%"></div>' +
        "</div>" +
        "</div>"
      );
    }

    function findCrossSellProduct(cartItemIds) {
      // Pick the cheapest product NOT already in the cart
      // ⚡ Bolt: Iterating over the pre-sorted list avoids O(n log n) sorting on every cart state change
      for (var i = 0; i < sortedCrossSellCandidates.length; i++) {
        var p = sortedCrossSellCandidates[i];
        if (cartItemIds.indexOf(p.id) === -1 && p.inStock !== false) {
          return p;
        }
      }
      return null;
    }

    function buildCrossSellHTML(product) {
      if (!product) return "";
      var imgSrc = product.image || "assets/img/placeholder-coming-soon.svg";
      if (window.YL_IMG_MANIFEST && window.YL_IMG_MANIFEST[imgSrc]) {
        imgSrc =
          window.YL_IMG_MANIFEST[imgSrc].avif || window.YL_IMG_MANIFEST[imgSrc].webp || imgSrc;
      }
      return (
        '<div class="cart-cross-sell">' +
        '<div class="cart-cross-sell__heading">Complete your ritual</div>' +
        '<div class="cart-cross-sell__item">' +
        '<img class="cart-cross-sell__img" src="' +
        attrEsc(imgSrc) +
        '" alt="' +
        attrEsc(product.name) +
        '" width="48" height="48" loading="lazy">' +
        '<div class="cart-cross-sell__info">' +
        '<div class="cart-cross-sell__name">' +
        attrEsc(product.name) +
        "</div>" +
        '<div class="cart-cross-sell__price">$' +
        product.price.toFixed(2) +
        "</div>" +
        "</div>" +
        '<button class="cart-cross-sell__add snipcart-add-item"' +
        ' aria-label="Add ' +
        attrEsc(product.name) +
        ' to cart"' +
        ' data-item-id="' +
        attrEsc(product.id) +
        '"' +
        ' data-item-price="' +
        product.price.toFixed(2) +
        '"' +
        ' data-item-url="/assets/data/snipcart-products.json"' +
        ' data-item-name="' +
        attrEsc(product.name) +
        '"' +
        ' data-item-image="' +
        attrEsc(imgSrc) +
        '"' +
        ">+ Add</button>" +
        "</div>" +
        "</div>"
      );
    }

    // Wait for Snipcart SDK to load, then hook into state changes and DOM updates
    document.addEventListener("snipcart.ready", function () {
      if (!window.Snipcart) return;

      var snipcartEl = document.getElementById("snipcart");
      var observer;

      function syncCart() {
        // Disconnect to avoid infinite recursion when we mutate the DOM
        if (snipcartEl && observer) {
          observer.disconnect();
        }

        try {
          var state = window.Snipcart.store.getState();
          var cart = state.cart;
          if (!cart) return;
          var total = cart.total || 0;
          var cartItemIds =
            cart.items && cart.items.items
              ? cart.items.items.map(function (item) {
                  return item.id;
                })
              : [];

          // Sync badge visibility based on items count
          var badges = document.querySelectorAll(".snipcart-items-count");
          var count = cart.items && typeof cart.items.count === "number" ? cart.items.count : 0;
          badges.forEach(function (badge) {
            if (count === 0) {
              badge.style.display = "none";
            } else {
              badge.style.display = "flex";
            }
          });

          // ⚡ Bolt: Scope querySelectors to snipcartEl instead of the entire document
          var snipcartContent = snipcartEl.querySelector(".snipcart-cart__content");
          if (snipcartContent) {
            var existing = snipcartContent.querySelector(".shipping-progress");
            var newProgressHTML = buildProgressHTML(total);
            if (!existing) {
              snipcartContent.insertAdjacentHTML("afterbegin", newProgressHTML);
            } else if (existing.outerHTML !== newProgressHTML) {
              existing.remove();
              snipcartContent.insertAdjacentHTML("afterbegin", newProgressHTML);
            }
          }

          // Inject/update cross-sell
          var snipcartFooter = snipcartEl.querySelector(".snipcart-cart__footer");
          if (snipcartFooter) {
            var existingCS = snipcartEl.querySelector(".cart-cross-sell");
            var crossProduct = findCrossSellProduct(cartItemIds);
            var newCSHTML = buildCrossSellHTML(crossProduct);

            if (!newCSHTML) {
              if (existingCS) existingCS.remove();
            } else {
              if (!existingCS) {
                snipcartFooter.insertAdjacentHTML("beforebegin", newCSHTML);
              } else {
                var currentCSProductId = existingCS.querySelector(".cart-cross-sell__add")
                  ? existingCS.querySelector(".cart-cross-sell__add").getAttribute("data-item-id")
                  : null;
                if (currentCSProductId !== crossProduct.id) {
                  existingCS.remove();
                  snipcartFooter.insertAdjacentHTML("beforebegin", newCSHTML);
                }
              }
            }
          }
        } catch (err) {
          /* Snipcart internal state shape changed -- degrade silently */
        } finally {
          // Re-observe after modifications
          if (snipcartEl && observer) {
            observer.observe(snipcartEl, { childList: true, subtree: true });
          }
        }
      }

      // Start observing DOM changes inside `#snipcart` (e.g. cart drawer opens, Vue re-renders)
      if (snipcartEl) {
        observer = new MutationObserver(syncCart);
        observer.observe(snipcartEl, { childList: true, subtree: true });
      }

      // Also subscribe to state changes to ensure we are triggered on every store update
      window.Snipcart.store.subscribe(syncCart);

      // Run once initially
      syncCart();
    });
  })();
  if ("serviceWorker" in navigator) {
    // Show a non-disruptive toast when a new SW version is ready,
    // instead of force-reloading mid-session (which can clear form
    // state and break the visitor's flow).
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      var toast = document.getElementById("sw-update-toast");
      if (!toast) {
        toast = document.createElement("div");
        toast.id = "sw-update-toast";
        toast.className = "sw-update-toast";
        toast.innerHTML =
          "<span>A new version is available!</span>" +
          '<button onclick="window.location.reload()" class="btn btn-sm btn-primary" style="margin-left:12px;">Update now</button>' +
          '<button onclick="this.parentElement.remove()" class="btn btn-sm btn-outline" style="margin-left:6px;" aria-label="Dismiss">&times;</button>';
        document.body.appendChild(toast);
        // Animate in
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            toast.classList.add("visible");
          });
        });
      }
    });

    function registerSW() {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.error("Service Worker registration failed:", err.toString());
      });
    }
    if (document.readyState === "complete") {
      registerSW();
    } else {
      window.addEventListener("load", () => {
        registerSW();
      });
    }
  }

  /* ---------- 2026 SOTA Deep-linking & Popularity Features ---------- */

  // 1. Deep-linking to open product lightbox on load
  if (window.location.hash) {
    var possibleProdId = window.location.hash.replace("#", "");
    var allItems = ((window.YL_PRODUCTS && window.YL_PRODUCTS.products) || []).concat(
      (window.YL_PRODUCTS && window.YL_PRODUCTS.bundles) || []
    );
    var matchedItem = allItems.find(function (i) {
      return i.id === possibleProdId;
    });
    if (matchedItem) {
      setTimeout(function () {
        if (typeof window.openLightbox === "function") {
          window.openLightbox(matchedItem.images || [matchedItem.image], matchedItem.image);
        }
      }, 400);
    }
  }

  // 2. Render Social Feed if enabled
  var socialFeedGrid = document.getElementById("socialFeedGrid");
  var homeSocialFeedSection = document.getElementById("homeSocialFeed");
  var enableSocialFeed = /*YL:site.enableSocialFeed*/ false; /*/YL:site.enableSocialFeed*/
  var enableJournal = /*YL:site.enableJournal*/ false; /*/YL:site.enableJournal*/

  if (enableSocialFeed && socialFeedGrid && homeSocialFeedSection && window.YL_SOCIAL_FEED) {
    var socialPosts = window.YL_SOCIAL_FEED.posts || [];
    if (socialPosts.length > 0) {
      homeSocialFeedSection.style.display = "block";
      socialFeedGrid.innerHTML = socialPosts
        .map(function (post) {
          return (
            '<a href="' +
            attrEsc(post.url || "#") +
            '" target="_blank" rel="noopener" class="card social-card reveal">' +
            '  <div class="card-img-wrap">' +
            '    <img src="' +
            attrEsc(post.image) +
            '" alt="Social Media Post" loading="lazy">' +
            "  </div>" +
            '  <div class="card-content">' +
            '    <p class="social-caption">' +
            attrEsc(post.caption) +
            "</p>" +
            '    <span class="sr-only">(opens in new tab)</span>' +
            "  </div>" +
            "</a>"
          );
        })
        .join("");
      wireReveal(socialFeedGrid);
    }
  }

  // 3. Render Journal (Blog) Page
  var journalApp = document.getElementById("journalApp");
  if (journalApp && window.YL_JOURNAL) {
    var journalPosts = window.YL_JOURNAL.posts || [];

    function renderJournalList() {
      if (!enableJournal || journalPosts.length === 0) {
        journalApp.innerHTML =
          '<div class="section-head reveal">' +
          "  <h2>Journal Coming Soon</h2>" +
          "  <p>Savanna is stirring up some stories. Check back soon for herbal folklore, batch updates, and behind-the-scenes thoughts.</p>" +
          "</div>";
        return;
      }

      var listHtml =
        '<div class="grid grid-3 stagger">' +
        journalPosts
          .map(function (post) {
            return (
              '<article class="card reveal">' +
              (post.image
                ? '<div class="card-media">' +
                  "  <picture>" +
                  '    <img src="' +
                  attrEsc(post.image) +
                  '" alt="' +
                  attrEsc(post.title) +
                  '" loading="lazy" width="400" height="300" style="object-fit:cover; width:100%; height:100%;">' +
                  "  </picture>" +
                  "</div>"
                : "") +
              '<div class="card-body">' +
              '  <span class="card-cat">Published ' +
              attrEsc(post.date) +
              "</span>" +
              '  <h3><a href="#post-' +
              attrEsc(post.id) +
              '">' +
              attrEsc(post.title) +
              "</a></h3>" +
              "  <p>" +
              attrEsc(post.excerpt) +
              "</p>" +
              '  <div class="card-foot">' +
              '    <div class="card-foot-row">' +
              '      <a href="#post-' +
              attrEsc(post.id) +
              '" class="btn btn-outline btn-sm">Read Post →</a>' +
              "    </div>" +
              "  </div>" +
              "</div>" +
              "</article>"
            );
          })
          .join("") +
        "</div>";

      journalApp.innerHTML = listHtml;
      wireReveal(journalApp);
    }

    function renderJournalDetail(postId) {
      var post = journalPosts.find(function (p) {
        return p.id === postId;
      });
      if (!post) {
        renderJournalList();
        return;
      }

      var paragraphs = post.content
        .split("\n\n")
        .map(function (p) {
          return "<p>" + attrEsc(p) + "</p>";
        })
        .join("");

      journalApp.innerHTML =
        '<div class="journal-detail">' +
        '  <div class="back-link reveal" id="journalBackBtn">← Back to Journal</div>' +
        '  <h2 class="reveal">' +
        attrEsc(post.title) +
        "</h2>" +
        '  <div class="meta reveal">Published on ' +
        attrEsc(post.date) +
        "</div>" +
        (post.image
          ? '  <img class="reveal" src="' +
            attrEsc(post.image) +
            '" alt="' +
            attrEsc(post.title) +
            '">'
          : "") +
        '  <div class="content reveal">' +
        paragraphs +
        "</div>" +
        "</div>";

      document.getElementById("journalBackBtn").addEventListener("click", function () {
        window.location.hash = "";
      });
      wireReveal(journalApp);
    }

    function routeJournal() {
      var hash = window.location.hash || "";
      if (hash.indexOf("#post-") === 0) {
        var postId = hash.replace("#post-", "");
        renderJournalDetail(postId);
      } else {
        renderJournalList();
      }
    }

    window.addEventListener("hashchange", routeJournal);
    routeJournal();
  }

  /* ---------- Load translator ---------- */
  (function () {
    var s = document.createElement("script");
    s.src = "assets/js/translator.js?v=2.0";
    s.defer = true;
    document.body.appendChild(s);
  })();
})();
