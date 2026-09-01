/* ==========================================================
   Y'ALLTERNATIVE LIVING | shared site behavior
   Zero dependencies, zero build step. Vanilla JS only so the
   whole site stays instant on any connection.
   ========================================================== */
/* global module */
(function () {
  "use strict";

  /* ---------- Analytics event adapter ----------
     The site's conversion events (Add to Cart, Purchase, Newsletter Signup,
     Site Search) were written against Plausible's window.plausible(name, {props})
     API. Analytics now runs on Umami -- cookieless, free, no consent banner, and
     it supports these same custom events. Rather than rewrite every call site,
     this thin adapter keeps the window.plausible(...) signature and forwards to
     umami.track(). If Umami's script hasn't loaded yet (it's `defer`) or a user
     blocks it, window.umami is simply absent and the event is skipped -- it must
     never throw or block the actual add-to-cart / checkout / search. */
  if (typeof window !== "undefined" && typeof window.plausible !== "function") {
    window.plausible = function (name, options) {
      try {
        if (window.umami && typeof window.umami.track === "function") {
          var props = options && options.props ? options.props : undefined;
          window.umami.track(name, props);
        }
      } catch {
        /* analytics is best-effort -- swallow everything */
      }
    };
  }

  /* ---------- Theme toggle (dark/light, persisted with in-memory cache) ---------- */
  var root = document.documentElement;
  var toggle = document.getElementById("themeToggle");
  var cachedTheme = null;

  function currentTheme() {
    if (cachedTheme !== null) return cachedTheme;
    // Storage access can throw (Safari private browsing, "block all
    // cookies," a locked-down webview) -- this runs as the very first
    // statement in the whole file, so an uncaught throw here used to
    // kill every other feature on the page (nav, cart, wishlist, shop
    // rendering, everything). Falling back to matchMedia keeps the
    // theme correct and lets the rest of the script keep running.
    try {
      var saved = localStorage.getItem("yl-theme");
      if (saved === "dark" || saved === "light") {
        cachedTheme = saved;
        return saved;
      }
    } catch {
      /* storage unavailable -- fall through to the media-query default */
    }
    cachedTheme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    return cachedTheme;
  }

  function applyTheme(theme) {
    cachedTheme = theme;
    root.setAttribute("data-theme", theme);
    if (toggle) toggle.setAttribute("aria-checked", theme === "light" ? "true" : "false");
  }

  applyTheme(currentTheme());

  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = currentTheme() === "light" ? "dark" : "light";
      try {
        localStorage.setItem("yl-theme", next);
      } catch {
        /* can't persist -- still flip the theme for this page view */
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
    var menuIconSVG =
      '<svg class="yl-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>';
    var closeIconSVG =
      '<svg class="yl-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

    function closeNav() {
      navLinks.classList.remove("open");
      navToggle.setAttribute("aria-expanded", "false");
      navToggle.setAttribute("aria-label", "Open menu");
      navToggle.innerHTML = menuIconSVG;
      syncNavInert();
    }

    navToggle.addEventListener("click", function () {
      var open = navLinks.classList.toggle("open");
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
      navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      navToggle.innerHTML = open ? closeIconSVG : menuIconSVG;
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

  /* ---------- Scroll reveal (IntersectionObserver Singleton) ----------
     Shared by initial page load, shop grid, events page, and filter updates.
     Uses a module-level singleton IntersectionObserver instance (sharedRevealIO)
     to eliminate observer allocation churn on every re-render or search pass. */
  var sharedRevealIO = null;

  function getRevealObserver() {
    if (!sharedRevealIO && "IntersectionObserver" in window && !window.navigator.webdriver) {
      sharedRevealIO = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              /* Drop the armed class rather than relying on `.in` winning the
                 cascade. Both selectors have equal specificity, so today `.in`
                 wins only because it is written second -- reordering those two
                 nested rules would leave revealed content invisible, with
                 nothing to hint why. */
              entry.target.classList.remove("reveal-armed");
              entry.target.classList.add("in");
              if (sharedRevealIO) {
                sharedRevealIO.unobserve(entry.target);
              }
            }
          });
        },
        { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
      );
    }
    return sharedRevealIO;
  }

  /* Has the browser put anything on screen yet? Before the first paint the
     page is still blank, so hiding an element costs nothing and the entrance
     animation plays exactly as designed. Measured on this site, that is the
     normal case: DOMContentLoaded lands at ~124ms and first paint at ~180ms.
     After a paint, though, the reader is already looking at the content --
     that is the slow load where this deferred script arrives late, and
     hiding what is on screen is the bug this guards against. */
  function hasPainted() {
    try {
      /* An entry type the browser does not implement comes back as an empty
         array rather than throwing, so a bare length check cannot tell
         "nothing has painted yet" apart from "this browser never reports
         paints". Those want opposite handling, so ask first. When the answer
         is unknowable, treat the page as painted: that leaves whatever is on
         screen alone, at the cost of the entrance animation on browsers old
         enough to lack paint timing. Hiding content a reader can already see
         is the failure this whole guard exists to prevent -- losing an
         animation is not. */
      var supportsPaintTiming =
        typeof PerformanceObserver !== "undefined" &&
        PerformanceObserver.supportedEntryTypes &&
        PerformanceObserver.supportedEntryTypes.indexOf("paint") !== -1;
      if (!supportsPaintTiming) return true;
      return performance.getEntriesByType("paint").length > 0;
    } catch (e) {
      return true;
    }
  }

  /* `serverRendered` marks the one call that runs over markup the browser
     parsed with the document, the only markup that can already be on screen
     when this runs. `.reveal` no longer carries the hidden state in CSS --
     this function arms it -- so once a paint has happened, anything visible
     must be left alone: hiding it would blink already-readable content out
     from under the reader. Dynamically injected nodes (shop grid, journal,
     filters) pass nothing: they are armed in the same task that inserts
     them, before any paint of those nodes, so they animate in as designed. */
  function wireReveal(root, serverRendered) {
    root = root || document;
    var els = root.querySelectorAll(".reveal:not(.in)");
    if (!els.length) return;
    var io =
      "IntersectionObserver" in window && !window.navigator.webdriver ? getRevealObserver() : null;
    if (!io) {
      els.forEach(function (el) {
        el.classList.add("in");
      });
      return;
    }
    var protectVisible = !!serverRendered && hasPainted();
    // Measure first, mutate second: interleaving the two would force a
    // layout recalc per element.
    var fold = window.innerHeight || document.documentElement.clientHeight;
    var tops = [];
    if (protectVisible) {
      els.forEach(function (el) {
        tops.push(el.getBoundingClientRect().top);
      });
    }
    els.forEach(function (el, i) {
      el.style.setProperty("--i", i % 8);
      if (protectVisible && tops[i] < fold) {
        el.classList.add("in");
        return;
      }
      el.classList.add("reveal-armed");
      io.observe(el);
    });
  }
  wireReveal(document, true);

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

      /* Kit/ConvertKit isn't wired up yet. Same reasoning as the contact form
         above: showing the subscribed-confirmation state here would tell the
         visitor they're on the list when no request was ever made, so they'd
         never think to sign up again. Be honest instead. */
      if (form.action.indexOf("YOUR_KIT_FORM_ACTION_URL") !== -1) {
        e.preventDefault();
        showFormFallback(
          form,
          "Our newsletter isn't connected yet -- you haven't been subscribed. Email us to be added: ",
          "y.allternative.living@gmail.com"
        );
        return;
      }

      /* Submit via AJAX so the page never navigates away to Kit.

         This used to pass mode:"no-cors", which makes the response opaque:
         status is always 0, res.ok is always false, and the promise resolves
         no matter what the server said. The old .then() therefore showed
         "You're on the list, y'all!" for every outcome, including a rejected
         or misrouted submission -- telling someone they had subscribed when
         they had not, so they would never think to try again. Kit answers
         preflight with `access-control-allow-origin: *` and permits POST plus
         the accept header, so a normal CORS request works and the response can
         actually be read. */
      e.preventDefault();
      var button = form.querySelector('button[type="submit"]');
      var buttonLabel = button ? button.textContent : "";
      if (button) {
        button.disabled = true;
        button.textContent = "Joining...";
      }

      var restoreButton = function () {
        if (!button) return;
        button.disabled = false;
        button.textContent = buttonLabel;
      };

      fetch(form.action, {
        method: "POST",
        body: new FormData(form),
        headers: { Accept: "application/json" }
      })
        .then(function (res) {
          if (!res.ok) throw new Error("Signup rejected: " + res.status);
          var box = form.closest(".footer-signup");
          if (box) box.classList.add("is-subscribed");
        })
        .catch(function () {
          /* Deliberately not falling back to form.submit() here. That fired a
             real full-page POST, dumping the visitor on Kit's own site with no
             way back. Say plainly that it did not go through and hand over a
             mailbox that does, matching the contact and restock handlers. */
          restoreButton();
          showFormFallback(
            form,
            "That didn't go through -- you haven't been subscribed. Email us and we'll add you: ",
            "y.allternative.living@gmail.com"
          );
        });
    });
  });

  /* ---------- Welcome page: show the subscriber discount code ----------
     welcome.html is where Kit's "after confirming redirect to" sends people
     once they click the confirmation link. The code itself lives in
     content.json under site.welcomeCode (editable at /admin), never hardcoded
     in the markup, so it can be rotated without a code change.

     Both blocks start hidden. If no real code is configured we reveal the
     "it's coming by email" copy instead of printing the placeholder --
     showing a code that fails at checkout is worse than showing none, and
     matches how the contact, review and newsletter handlers refuse to fake
     a result they cannot deliver. */
  var welcomeCodeEl = document.getElementById("welcomeCode");
  if (welcomeCodeEl) {
    var welcomeSite = (window.YL_CONTENT && window.YL_CONTENT.site) || {};
    var welcomeCode = welcomeSite.welcomeCode;
    var codeIsReal = !!welcomeCode && welcomeCode !== "YOUR_WELCOME_CODE";
    var codeCard = document.getElementById("welcomeCodeCard");
    var noCode = document.getElementById("welcomeNoCode");

    if (codeIsReal) {
      welcomeCodeEl.textContent = welcomeCode;
      if (codeCard) codeCard.hidden = false;
    } else if (noCode) {
      noCode.hidden = false;
    }
  }

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
    if (typeof HTMLDialogElement !== "undefined" && !("closedBy" in HTMLDialogElement.prototype)) {
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

      /* Formspree's review form ID is still the placeholder. Left alone, the
         fetch below 404s, res.ok is false, and the fallback fires a real
         full-page POST -- dumping the customer on a Formspree error page with
         their review lost. Stop before that and point them somewhere useful,
         matching the contact form and newsletter handlers above. */
      if (form.action.indexOf("YOUR_FORMSPREE_FORM_ID") !== -1) {
        e.preventDefault();
        showFormFallback(
          form,
          "Review submissions aren't connected yet -- this wasn't sent. Please email your review to ",
          "y.allternative.living@gmail.com"
        );
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
            showFormFallback(
              form,
              "Review submission failed -- your review was not sent. Please email your review directly to ",
              "y.allternative.living@gmail.com"
            );
          }
        })
        .catch(function () {
          showFormFallback(
            form,
            "Review submission failed -- your review was not sent. Please email your review directly to ",
            "y.allternative.living@gmail.com"
          );
        });
    });
  });

  /* Inline "this form isn't hooked up yet" notice, used by the contact and
     newsletter handlers while their provider IDs are still placeholders.
     role="alert" so it's announced rather than silently appearing. Renders a
     real mailto link so the visitor still has a way to reach a human. */
  function showFormFallback(form, message, email) {
    var existing = form.querySelector(".form-fallback-note");
    if (!existing) {
      existing = document.createElement("p");
      existing.className = "form-fallback-note";
      existing.setAttribute("role", "alert");
      form.appendChild(existing);
    }
    existing.textContent = message;
    if (email) {
      var a = document.createElement("a");
      a.href = "mailto:" + email;
      a.textContent = email;
      existing.appendChild(a);
    }
  }

  /* ---------- Contact form submit handler (AJAX via Formspree) ---------- */
  var contactForms = document.querySelectorAll(".contact-form");
  contactForms.forEach(function (form) {
    form.addEventListener("submit", function (e) {
      var col = form.closest(".contact-form-col");
      /* Formspree isn't wired up yet (the action is still the placeholder).
         This used to show the normal "thanks, we got it!" confirmation and
         then drop the message on the floor -- the visitor walks away believing
         Savanna has their enquiry, and nobody ever sees it. A form that fails
         silently while claiming success is worse than one that plainly
         doesn't work, so say so and hand over the real mailbox instead. */
      if (form.action.indexOf("YOUR_FORM_ID") !== -1) {
        e.preventDefault();
        showFormFallback(
          form,
          "This form isn't connected yet -- your message wasn't sent. Please email us directly at ",
          "y.allternative.living@gmail.com"
        );
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
            showFormFallback(
              form,
              "Message sending failed -- your message was not sent. Please email us directly at ",
              "y.allternative.living@gmail.com"
            );
          }
        })
        .catch(function () {
          showFormFallback(
            form,
            "Message sending failed -- your message was not sent. Please email us directly at ",
            "y.allternative.living@gmail.com"
          );
        });
    });
  });

  /* ---------- Wishlist / "Saved For Later" (localStorage, no backend) ----------
     A client-side save list that persists in the shopper's browser --
     nothing to sign in to, nothing server-side to build. Every saved
     item's real path to purchase is "Add to Cart" -> checkout, right here
     on the site (see addToCartHTML() above); this doesn't link out to
     Etsy or anywhere else. */
  var WISH_KEY = "yl-wishlist";
  var wishHeartSVG =
    '<svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>';

  /* ---------- shared: read a CMS feature switch ----------
     window.YL_CONTENT is generated from assets/data/content.json, so it is
     the authority for every /admin toggle. Several switches shipped read by
     nothing at all (the order lookup, the countdown ticker, the quiz), which
     meant flipping one in the dashboard changed nothing in the browser.
     Absent means on: that is how each of these features shipped, and a page
     that loads without content-data.js must not silently lose them. */
  function siteFlagEnabled(name) {
    var site = (window.YL_CONTENT && window.YL_CONTENT.site) || {};
    return site[name] !== false;
  }

  /* ---------- shared: escape a value for safe use inside an HTML attribute ---------- */
  function attrEsc(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/`/g, "&#96;");
  }

  /* ---------- shared: only allow http(s)/relative links into href= ----------
     attrEsc() alone stops attribute-breakout but not a same-quote-safe
     `javascript:` URL, which still executes on click. Used for event/social
     post URLs that come from CMS-editable JSON (events.json, social feed). */
  function safeUrl(url) {
    if (!url) return "";
    var trimmed = String(url).trim();
    if (/^(https?:)?\/\//i.test(trimmed) || /^\//.test(trimmed)) return trimmed;
    return "";
  }

  /* ---------- shared: only allow safe schemes into a markdown link's href ----------
     safeUrl() above is deliberately narrow (absolute http(s), or a path that
     starts with "/") because it guards machine-supplied feed/event URLs. A
     link typed into a journal post also has to accept "mailto:" and ordinary
     relative paths like "shop.html#gift-cards", while still refusing anything
     that can execute.

     The whitespace/control-character strip is the load-bearing part: a browser
     removes tabs and newlines from a URL and trims leading control characters
     BEFORE it decides what the scheme is, so " javascript:alert(1)" and
     "java<TAB>script:alert(1)" both run. Strip first, then decide. */
  function safeLinkUrl(url) {
    if (!url) return "";
    var raw = String(url);
    var cleaned = "";
    for (var i = 0; i < raw.length; i++) {
      var code = raw.charCodeAt(i);
      // Everything at or below 0x20 is a space or a control character, and
      // 0x7F is DEL -- none of them belong inside a URL.
      if (code > 32 && code !== 127) cleaned += raw.charAt(i);
    }
    if (!cleaned) return "";
    var scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
    if (scheme) {
      var name = scheme[1].toLowerCase();
      if (name !== "http" && name !== "https" && name !== "mailto") return "";
      return cleaned;
    }
    // No scheme at all -- "shop.html", "/journal.html", "#gift-cards",
    // "//example.com". A relative reference can't execute.
    return cleaned;
  }

  /* ---------- shared: minimal, escape-first Markdown renderer ----------
     The Apothecary Journal's post body is written by Savanna in /admin (the
     `content` field is a rich-text editor there) and rendered on journal.html
     through innerHTML, so this has exactly two jobs: cover the handful of
     formatting marks a shop owner actually needs, and never let post text
     become live markup.

     Why this isn't a vendored library. Self-hosting one would have been fine
     -- the site's CSP only blocks CDN scripts, and we already self-host the
     fonts for that same reason (docs/SELF-HOSTING-FONTS.md) -- so this was a
     trade, not a constraint:
       - snarkdown (1.9 KB minified, MIT) is the closest fit by size, but its
         last release was 2020, it passes raw HTML straight through (an
         `<img src=x onerror=...>` in a post survives verbatim), writes hrefs
         with no scheme check (`[x](javascript:alert(1))` becomes a live
         link), and separates paragraphs with `<br />` instead of `<p>` --
         which on its own would restyle every post already published, since
         journal.html styles `.content p`. Fixing the first two means forking
         its single dense minified regex, which throws away the reason to
         vendor it in the first place.
       - marked (40 KB minified) and markdown-it (124 KB minified) are each
         bigger than every file this site ships except main.js itself, for a
         page that renders a couple of posts. marked doesn't sanitize either
         (its docs hand you off to DOMPurify); markdown-it is genuinely safe
         by default (html:false plus a scheme allowlist) but is ~15x the size
         of the ~8 KB below for the same handful of formatting marks.
     So: escape with attrEsc() FIRST, then add formatting to text that can no
     longer contain markup. Anything unsupported degrades to plain text. */

  /* Inline emphasis. Only ever runs on text attrEsc() has already escaped,
     so there is no "<" left for it to turn into a tag. Sveltia's editor
     writes **bold** and _italic_; *italic* and __bold__ are accepted too
     because that's what people type by hand. An underscore inside a word
     (soap_batch_2) is not emphasis, which is why those two rules check the
     characters on either side. */
  function mdEmphasis(escaped) {
    return escaped
      .replace(/(^|[^A-Za-z0-9_])__([^\n]+?)__(?![A-Za-z0-9_])/g, "$1<strong>$2</strong>")
      .replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^A-Za-z0-9_])_([^_\n]+?)_(?![A-Za-z0-9_])/g, "$1<em>$2</em>")
      .replace(/\*([^*\n]+?)\*/g, "<em>$1</em>");
  }

  /* [label](url). The URL may not contain whitespace, and may contain at most
     one nested pair of parentheses -- enough for the Wikipedia-style
     ".../Arnica_(plant)" links an herbal blog actually uses, while staying a
     single unambiguous match per link (the two alternatives can't match the
     same character, so there is nothing here to backtrack over). */
  var MD_LINK_RE = /\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)/g;

  /* One run of markdown text -> safe HTML. Escaping happens per slice so the
     URL is checked in its raw form (before "&" becomes "&amp;") and only then
     escaped for the attribute it lands in. */
  function mdInline(text) {
    var html = "";
    var lastIndex = 0;
    var match;
    MD_LINK_RE.lastIndex = 0;
    while ((match = MD_LINK_RE.exec(text)) !== null) {
      html += mdEmphasis(attrEsc(text.slice(lastIndex, match.index)));
      var href = safeLinkUrl(match[2]);
      var label = mdEmphasis(attrEsc(match[1]));
      // A rejected URL (javascript:, data:, ...) keeps the words and drops
      // the link -- it never reaches an href.
      html += href ? '<a href="' + attrEsc(href) + '">' + label + "</a>" : label;
      lastIndex = MD_LINK_RE.lastIndex;
    }
    return html + mdEmphasis(attrEsc(text.slice(lastIndex)));
  }

  /* Block structure: blank-line separated paragraphs (what every post written
     before this existed already is), "## " headings, "- " bullet lists,
     "1. " numbered lists, and "***" dividers. Deliberately not a CommonMark
     parser -- no tables, code blocks, blockquotes or images, all of which are
     also switched off in the editor (see admin/config.yml's `buttons` and
     `editor_components` for the journal `content` field). */
  function renderMarkdown(text) {
    if (text == null) return "";
    var lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    var html = "";
    var para = [];
    var items = [];
    var listTag = "";

    function flushPara() {
      if (!para.length) return;
      // Joined with "\n", not " ": a plain-text post then renders the exact
      // same bytes it did before this function existed.
      html += "<p>" + mdInline(para.join("\n")) + "</p>";
      para = [];
    }

    function flushList() {
      if (!items.length) return;
      html +=
        "<" +
        listTag +
        ">" +
        items
          .map(function (item) {
            return "<li>" + mdInline(item) + "</li>";
          })
          .join("") +
        "</" +
        listTag +
        ">";
      items = [];
      listTag = "";
    }

    function pushItem(tag, item) {
      // A "1." right after a "-" starts a second, differently-tagged list.
      if (listTag && listTag !== tag) flushList();
      flushPara();
      listTag = tag;
      items.push(item);
    }

    lines.forEach(function (line) {
      var trimmed = line.trim();
      var heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
      var bullet = /^[-*+]\s+(.+)$/.exec(trimmed);
      var numbered = /^\d{1,9}[.)]\s+(.+)$/.exec(trimmed);

      if (!trimmed) {
        flushPara();
        flushList();
      } else if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
        flushPara();
        flushList();
        html += "<hr>";
      } else if (heading) {
        flushPara();
        flushList();
        // The post's own title is the page's <h2>, so headings inside a post
        // start at <h3> and never skip a level (screen-reader outline).
        var tag = heading[1].length > 2 ? "h4" : "h3";
        html += "<" + tag + ">" + mdInline(heading[2]) + "</" + tag + ">";
      } else if (bullet) {
        pushItem("ul", bullet[1]);
      } else if (numbered) {
        pushItem("ol", numbered[1]);
      } else {
        flushList();
        para.push(line);
      }
    });

    flushPara();
    flushList();
    return html;
  }

  /* ---------- shared: horizontal swipe gesture ----------
     Both the product lightbox and the events carousel wired up their own
     near-identical touchstart/touchend handlers with the same 50px
     threshold. Centralize it here so there's one implementation to reason
     about; each caller just supplies what a left/right swipe should do. */
  var SWIPE_THRESHOLD_PX = 50;
  function attachSwipe(el, onSwipeLeft, onSwipeRight) {
    if (!el) return;
    var startX = 0;
    el.addEventListener(
      "touchstart",
      function (e) {
        startX = e.changedTouches[0].screenX;
      },
      { passive: true }
    );
    el.addEventListener(
      "touchend",
      function (e) {
        var diff = e.changedTouches[0].screenX - startX;
        if (Math.abs(diff) <= SWIPE_THRESHOLD_PX) return;
        if (diff < 0) onSwipeLeft();
        else onSwipeRight();
      },
      { passive: true }
    );
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
    var normalizedPath = (imagePath || "").replace(/^\/+/, "");
    var manifest = window.YL_IMAGES && window.YL_IMAGES[normalizedPath];
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
    /* The active slide opens the full-size lightbox on click. It used to be a
       bare <div> with a pointer cursor and nothing else, which made enlarging
       a product photo mouse-only -- not reachable by Tab, not operable by
       Enter/Space, invisible to screen readers. That's a WCAG 2.1.1 (Keyboard)
       failure on the main shopping surface. Exposing it as a real button
       (role + tabindex + name; key handling lives in the delegated listener
       further down) makes the gallery operable without a mouse.
       Only the active slide is in the tab order -- the inactive ones are
       visually stacked behind it and are reached via the dot buttons, so
       putting all four in the tab order would just add dead stops. */
    var slideA11y =
      ' role="button" aria-label="' + attrEsc("Enlarge photo of " + (p.name || "product")) + '"';
    var slides = allImages
      .map(function (imgPath, i) {
        if (i === 0) {
          var o = Object.assign({}, firstSlideOpts, { imagePath: imgPath });
          return (
            '<div class="card-gallery-slide active" data-idx="0" tabindex="0"' +
            slideA11y +
            ">" +
            pictureHTML(p, o) +
            "</div>"
          );
        }
        return (
          '<div class="card-gallery-slide" data-idx="' +
          i +
          '" tabindex="-1"' +
          slideA11y +
          ' data-image="' +
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

  /* ---------- "Add to Cart" button builder ----------
     Emits the data-item-* attributes assets/js/cart.js reads at click time
     (id, name, price, image, and -- for products with a size/scent/blend
     choice -- data-item-custom1-name/-options/-value). The cart itself
     re-validates every price server-side against products.json before
     Stripe Checkout is ever created (see workers/checkout.js), so nothing
     here needs to be trusted, just read. */
  function addToCartHTML(p, extraClass) {
    if (p.id === "yallternative-gift-card") {
      return (
        /* btn-outline, not btn-secondary: there is no .btn-secondary rule in
           styles.css, and bare .btn carries no background and a transparent
           border, so the gift card's "Configure Card" rendered as unstyled
           inherited text in a row of solid buttons. btn-outline is this
           design system's secondary variant (what the old class name was
           reaching for) and keeps it visibly distinct from Add to Cart. */
        '<a href="#gift-cards" class="btn btn-outline btn-sm' +
        (extraClass ? " " + extraClass : "") +
        '">Configure Card</a>'
      );
    }

    // Real Etsy listings for some products sell more than one size/scent/
    // blend under a single listing (see p.variants, sourced from actual
    // listing research). The data-item-customN-* attribute convention
    // (a holdover naming scheme from this cart's Snipcart-era predecessor,
    // kept because it already threads through every button and both cart.js
    // and the checkout Worker read it) declares every choice and its price
    // delta: data-item-customN-options lists them, data-item-customN-value
    // is the one currently selected. variantSelectHTML()'s change handler
    // keeps -value (and the base data-item-price for delta'd variants) in
    // sync with whatever the shopper picks before they click this button.
    // Sold-out options are left out of the cart attributes entirely: the
    // picker (variantSelectHTML) shows them disabled for honesty, but the
    // cart should never be able to resolve one. The checkout Worker
    // re-rejects them server-side too (resolveUnitAmountCents), so a
    // tampered button can't order a sold-out size either.
    var variantAttrs = "";
    var availableOptions =
      p.variants && Array.isArray(p.variants.options)
        ? p.variants.options.filter(function (o) {
            return !o.soldOut;
          })
        : [];
    if (availableOptions.length) {
      var optionsStr = availableOptions
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
        attrEsc(availableOptions[0].label) +
        '"';
    }

    // Real, honest sold-out state: p.stock is a manually-maintained field
    // in products-data.js (never fabricated -- undefined/null means "not
    // tracked," not "unlimited," and the site never invents a number).
    // When Savanna sets it to 0, the button becomes inert instead of
    // silently accepting an order she can't fulfill.
    var siteCfg = (window.YL_CONTENT && window.YL_CONTENT.site) || {};
    var enableAlerts = siteCfg.enableRestockAlerts !== false;
    var notifyBtn;

    if (p.comingSoon) {
      notifyBtn = enableAlerts
        ? '<button type="button" class="btn btn-ghost btn-sm yl-notify-toggle" data-notify-for="' +
          attrEsc(p.id) +
          '" aria-expanded="false">Notify Me When Back in Stock</button>'
        : "";
      return (
        '<button type="button" class="btn btn-outline btn-sm' +
        (extraClass ? " " + extraClass : "") +
        '" disabled aria-disabled="true">Coming Soon</button>' +
        notifyBtn
      );
    }

    // Every size/scent option sold out counts as the product being sold out:
    // there is nothing left to order, so render the same honest inert button
    // (with its restock-alert signup) instead of an Add to Cart that could
    // only ever produce an unfulfillable order.
    var everyVariantSoldOut =
      p.variants &&
      Array.isArray(p.variants.options) &&
      p.variants.options.length > 0 &&
      !availableOptions.length;

    if (p.stock === 0 || p.inStock === false || everyVariantSoldOut) {
      notifyBtn = enableAlerts
        ? '<button type="button" class="btn btn-ghost btn-sm yl-notify-toggle" data-notify-for="' +
          attrEsc(p.id) +
          '" aria-expanded="false">Notify Me When Back in Stock</button>'
        : "";
      return (
        '<button type="button" class="btn btn-outline btn-sm' +
        (extraClass ? " " + extraClass : "") +
        '" disabled aria-disabled="true">Sold Out</button>' +
        notifyBtn
      );
    }

    // data-item-max-quantity is a real, HTML-only per-order cap read by
    // cart.js (which clamps to the lower of this and its own 99-unit hard
    // ceiling) -- unlike a live decrementing counter, it doesn't need a
    // backend to enforce. Only added when a real stock count exists.
    var stockAttrs =
      typeof p.stock === "number" && p.stock > 0 ? ' data-item-max-quantity="' + p.stock + '"' : "";

    return (
      '<button type="button" class="btn btn-primary btn-sm yl-add-item' +
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
  function getVolumePricingRules() {
    if (window.YL_PRODUCTS && Array.isArray(window.YL_PRODUCTS.volumePricing)) {
      return window.YL_PRODUCTS.volumePricing.filter(function (r) {
        return r && r.enabled !== false;
      });
    }
    if (
      window.YL_PRODUCTS &&
      window.YL_PRODUCTS.shop &&
      Array.isArray(window.YL_PRODUCTS.shop.volumePricing)
    ) {
      return window.YL_PRODUCTS.shop.volumePricing.filter(function (r) {
        return r && r.enabled !== false;
      });
    }
    return [
      {
        id: "salves-2oz",
        name: "2oz Salve Multi-Buy",
        category: "salves",
        qualifyingVariant: "2oz",
        minQuantity: 2,
        unitPrice: 14.99,
        label: "2+ for $14.99 each",
        enabled: true
      }
    ];
  }

  function getMatchingVolumeRule(p) {
    if (!p || !p.category) return null;
    var rules = getVolumePricingRules();
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.category === p.category) {
        if (r.qualifyingVariant) {
          if (
            p.id === "miracle-balm" &&
            String(r.qualifyingVariant).toLowerCase().indexOf("2oz") !== -1
          ) {
            continue;
          }
          if (p.variants && Array.isArray(p.variants.options) && p.variants.options.length > 0) {
            var normQ = String(r.qualifyingVariant).trim().toLowerCase().replace(/\s+/g, "");
            var hasVariant = p.variants.options.some(function (opt) {
              var normL = String(opt.label || "")
                .trim()
                .toLowerCase()
                .replace(/\s+/g, "");
              return normL === normQ;
            });
            if (!hasVariant) continue;
          }
        }
        return r;
      }
    }
    return null;
  }

  var LOW_STOCK_THRESHOLD = 5;
  function stockBadgeHTML(p) {
    // Sale badge: build-site-data.js bakes `sale: {label}` onto every product
    // in a discounted category (see its "Process Products" step) -- this is
    // what finally renders it. Styling already existed (.stock-badge.sale-badge
    // in styles.css) but was never emitted by any JS until now. Suppressed on
    // coming-soon and sold-out cards: "on sale" on something you can't buy
    // reads as a mistake.
    var volumeRule = getMatchingVolumeRule(p);
    var volumeBadgeText = "";
    if (volumeRule) {
      var rawLabel =
        volumeRule.label ||
        volumeRule.minQuantity + "+ for $" + Number(volumeRule.unitPrice).toFixed(2) + " ea";
      volumeBadgeText = rawLabel.replace(/\s*each$/i, " ea");
    }

    var saleBadge =
      p.sale && p.sale.label
        ? '<span class="stock-badge sale-badge">' + attrEsc(p.sale.label) + "</span>"
        : volumeBadgeText
          ? '<span class="stock-badge sale-badge">' + attrEsc(volumeBadgeText) + "</span>"
          : "";
    if (p.comingSoon) return '<span class="stock-badge low-stock">Coming Soon</span>';
    if (typeof p.stock !== "number") return saleBadge;
    if (p.stock === 0) return '<span class="stock-badge sold-out">Sold out</span>';
    if (p.stock <= LOW_STOCK_THRESHOLD)
      return saleBadge + '<span class="stock-badge low-stock">Only ' + p.stock + " left</span>";
    return saleBadge;
  }

  /* Price with an honest markdown: when a category sale is active
     (p.sale + p.originalPrice, both baked by build-site-data.js), show the
     sale price with the pre-sale price struck through -- the exact pattern
     bundlesHTML() already uses for a bundle's full price. No sale, no extra
     markup: renders the same bytes it always did. */
  function priceHTML(p) {
    var html = '<span class="price">$' + p.price.toFixed(2);
    if (p.sale && typeof p.originalPrice === "number" && p.originalPrice > p.price) {
      html += ' <s class="original-price">$' + p.originalPrice.toFixed(2) + "</s>";
    }
    return html + "</span>";
  }

  /* ---------- Size/scent/blend picker (only for products that have one) ----------
     The <option> value doubles as the exact label the button's
     data-item-custom1-value must match (see addToCartHTML() and cart.js's
     deltaForLabel()); data-delta feeds the price-update math in the
     change handler below. Real <select> means full keyboard/AT support
     for free -- no custom listbox widget needed for something this simple. */
  function variantSelectHTML(p) {
    if (p.id === "yallternative-gift-card") return "";
    if (!p.variants || !Array.isArray(p.variants.options) || !p.variants.options.length) return "";
    /* A sold-out option stays visible but disabled -- honest "S — sold out"
       beats the option silently vanishing (which reads as "we don't make S").
       `selected` goes explicitly on the first available option: per the HTML
       spec the browser's default is the first non-disabled option anyway,
       but being explicit keeps that guaranteed when the first option in the
       list is the sold-out one. */
    var firstAvailableSelected = false;
    var options = p.variants.options
      .map(function (o) {
        var delta = o.priceDelta || 0;
        var priceSuffix = delta
          ? " (" + (delta < 0 ? "-$" + Math.abs(delta).toFixed(2) : "+$" + delta.toFixed(2)) + ")"
          : "";
        var stateAttrs = "";
        if (o.soldOut) {
          stateAttrs = ' disabled aria-disabled="true"';
          priceSuffix = " — sold out";
        } else if (!firstAvailableSelected) {
          firstAvailableSelected = true;
          stateAttrs = " selected";
        }
        return (
          '<option value="' +
          attrEsc(o.label) +
          '" data-delta="' +
          delta +
          '"' +
          stateAttrs +
          ">" +
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

  /* ---------- Global Product Map Index (O(1) lookups) ---------- */
  var productMapCache = null;

  function getProductMap() {
    var products = (window.YL_PRODUCTS && window.YL_PRODUCTS.products) || [];
    var bundles = (window.YL_PRODUCTS && window.YL_PRODUCTS.bundles) || [];
    var expectedCount = products.length + bundles.length * 2;
    if (!productMapCache || productMapCache.size !== expectedCount) {
      productMapCache = new Map();
      products.forEach(function (p) {
        if (p && p.id) {
          productMapCache.set(p.id, p);
        }
      });
      bundles.forEach(function (b) {
        if (b && b.id) {
          productMapCache.set(b.id, b);
          productMapCache.set("bundle-" + b.id, b);
        }
      });
    }
    return productMapCache;
  }

  /* ---------- Wishlist / "Saved For Later" (localStorage + in-memory cache) ---------- */
  var wishCache = null;
  var wishSet = null;

  /**
   * Retrieves the current wishlist array from in-memory cache / localStorage.
   *
   * @return {!Array<string>} An array of product ID strings.
   */
  function getWishlist() {
    if (wishCache === null) {
      try {
        var raw = localStorage.getItem(WISH_KEY);
        wishCache = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(wishCache)) wishCache = [];
      } catch {
        wishCache = [];
      }
      wishSet = new Set(wishCache);
    }
    return wishCache;
  }

  /**
   * Saves the current wishlist array to localStorage and updates UI.
   *
   * @param {!Array<string>} list An array of product ID strings.
   */
  function saveWishlist(list) {
    wishCache = Array.isArray(list) ? list : [];
    wishSet = new Set(wishCache);
    try {
      localStorage.setItem(WISH_KEY, JSON.stringify(wishCache));
    } catch {
      /* storage unavailable -- badge/drawer below still reflect this
         session's in-memory state, it just won't persist on reload */
    }
    updateWishBadge();
    renderWishDrawer();
  }

  /**
   * Checks if a product ID is currently present in the wishlist via O(1) Set lookup.
   *
   * @param {string} id The product ID string.
   * @return {boolean} True if the product is in the wishlist, false otherwise.
   */
  function isWished(id) {
    if (wishSet === null) {
      getWishlist();
    }
    return wishSet.has(id);
  }

  function syncWishButtons(id) {
    var buttons = id
      ? document.querySelectorAll('.wish-btn[data-id="' + id + '"]')
      : document.querySelectorAll(".wish-btn[data-id]");

    buttons.forEach(function (btn) {
      var itemID = btn.getAttribute("data-id");
      var active = isWished(itemID);
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
   * Toggles the presence of a product ID in the wishlist and updates UI states.
   *
   * @param {string} id The product ID string.
   */
  function toggleWish(id) {
    var list = getWishlist().slice();
    var i = list.indexOf(id);
    if (i === -1) list.push(id);
    else list.splice(i, 1);
    saveWishlist(list);
    syncWishButtons(id);
  }

  /**
   * Updates the text content of the header wishlist count badge.
   */
  function updateWishBadge() {
    var badge = document.getElementById("wishCount");
    var count = getWishlist().length;
    if (badge) badge.textContent = count > 0 ? String(count) : "";
  }

  /* Cross-tab state synchronization for Wishlist, Recently Viewed & Theme */
  window.addEventListener("storage", function (e) {
    if (e.key === WISH_KEY) {
      wishCache = null;
      wishSet = null;
      getWishlist();
      updateWishBadge();
      renderWishDrawer();
      syncWishButtons();
    } else if (e.key === RECENTLY_VIEWED_KEY) {
      recentlyViewedCache = null;
      getRecentlyViewed();
      renderRecentlyViewedCarousel();
    } else if (e.key === "yl-theme" && (e.newValue === "dark" || e.newValue === "light")) {
      applyTheme(e.newValue);
    }
  });
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
      '<button class="btn btn-primary btn-block cart-toggle" type="button">View Cart &amp; Checkout</button>' +
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
    var pMap = getProductMap();
    var items = ids
      .map(function (id) {
        return pMap.get(id);
      })
      .filter(Boolean);
    if (!items.length) {
      body.innerHTML =
        '<div class="wish-empty"><span class="glyph" aria-hidden="true"><svg class="yl-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg></span>Nothing saved yet. Tap the heart on anything in the shop to keep it here.</div>';
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
          priceHTML(p) +
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
    var p = getProductMap().get(productId);
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
    /* Without a name a screen reader announces this as just "dialog" -- the
       other two dialogs on the page both carry aria-labelledby, this one was
       missed. */
    dialog.setAttribute("aria-label", "Product photo viewer");
    dialog.setAttribute("closedby", "any");
    dialog.innerHTML =
      '<button type="button" class="lightbox-close" aria-label="Close lightbox">&times;</button>' +
      '<div class="lightbox-content">' +
      '  <button type="button" class="lightbox-prev" aria-label="Previous image">&#10094;</button>' +
      '  <img id="lightboxImage" src="" alt="Enlarged product image">' +
      '  <button type="button" class="lightbox-next" aria-label="Next image">&#10095;</button>' +
      "</div>" +
      '<div class="lightbox-dots" id="lightboxDots"></div>' +
      '<div class="lightbox-ritual-wrap" id="lightboxRitualWrap"></div>';
    document.body.appendChild(dialog);

    var currentImages = [];
    var currentIndex = 0;
    var imgEl = dialog.querySelector("#lightboxImage");
    var dotsContainer = dialog.querySelector("#lightboxDots");
    var ritualWrap = dialog.querySelector("#lightboxRitualWrap");

    function showImage(idx) {
      /* With no images the index maths below lands on currentImages[0] ===
         undefined, and `img.src = undefined` stringifies to "undefined" --
         a real request for /undefined (404) behind a broken-image icon. */
      if (!currentImages.length) return;
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
    attachSwipe(
      dialog,
      function () {
        showImage(currentIndex + 1);
      },
      function () {
        showImage(currentIndex - 1);
      }
    );

    window.openLightbox = function (images, startSrc, productId) {
      currentImages = images || [];
      // Nothing to enlarge: opening an empty viewer shows the reader a blank
      // modal they then have to dismiss.
      if (!currentImages.length) return;
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

      if (ritualWrap) {
        if (productId) {
          var pMap = getProductMap();
          var prod = pMap ? pMap.get(productId) : null;
          if (!prod && window.YL_SEARCH_INDEX && Array.isArray(window.YL_SEARCH_INDEX.products)) {
            prod = window.YL_SEARCH_INDEX.products.find(function (p) {
              return p && p.id === productId;
            });
          }
          if (prod && Array.isArray(prod.pairsWith) && prod.pairsWith.length) {
            ritualWrap.innerHTML = renderModalRitualHtml(prod, pMap);
            ritualWrap.style.display = "block";
            var modalRitualSec = ritualWrap.querySelector("#modalRitualSection");
            if (modalRitualSec) {
              initPdpRitualSection(modalRitualSec);
            }
          } else {
            ritualWrap.innerHTML = "";
            ritualWrap.style.display = "none";
          }
        } else {
          ritualWrap.innerHTML = "";
          ritualWrap.style.display = "none";
        }
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
          var item = getProductMap().get(prodId);
          if (item && item.images && item.images.length) {
            /* p.images holds only the ALT photos -- the primary p.image is
               not in it (see cardGalleryHTML, which renders
               [p.image].concat(p.images)). Passing item.images alone left
               the primary photo out of the lightbox entirely, so clicking
               the default slide "enlarged" the first alt photo instead. */
            var allPhotos = [item.image].concat(item.images).filter(Boolean);
            var activeImg = slide.querySelector("img");
            var src = activeImg ? activeImg.getAttribute("src") : allPhotos[0];
            window.openLightbox(allPhotos, src, prodId);
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
      var isActive = slide.getAttribute("data-idx") === idx;
      slide.classList.toggle("active", isActive);
      /* Keep exactly one slide per gallery in the tab order -- the visible
         one. The others sit stacked behind it, so a tab stop on them would
         focus something nobody can see. */
      slide.setAttribute("tabindex", isActive ? "0" : "-1");
    });
    gallery.querySelectorAll(".card-gallery-dot").forEach(function (d) {
      var active = d === dot;
      d.classList.toggle("active", active);
      d.setAttribute("aria-pressed", active ? "true" : "false");
    });
  });

  /* ---------- Build-Your-Own Box ----------
     Shopper picks their own mix of eligible goods for a configured discount.
     Everything here is display only: the authoritative price is recomputed
     server-side in workers/checkout.js (resolveCustomBoxCents) from the same
     products.json and the same shop.customBox rules, so a tampered client
     can't invent a cheap box. Sizes, discount and eligible categories all
     come from the CMS. */
  function initCustomBox() {
    var section = document.getElementById("custom-box-section");
    var card = document.getElementById("customBoxCard");
    if (!section || !card) return;

    var site = (window.YL_CONTENT && window.YL_CONTENT.site) || {};
    var data = window.YL_PRODUCTS || {};
    var cfg = (data.shop && data.shop.customBox) || null;
    if (site.enableCustomBoxBuilder === false || !cfg) {
      section.hidden = true;
      return;
    }

    var minItems = cfg.minItems || 3;
    var maxItems = cfg.maxItems || 5;
    var pct = cfg.discountPercent || 0;
    var eligibleCats = cfg.eligibleCategories || [];
    var eligible = (data.products || []).filter(function (p) {
      if (p.comingSoon) return false;
      if (p.id === "yallternative-gift-card") return false;
      return !eligibleCats.length || eligibleCats.indexOf(p.category) !== -1;
    });
    if (eligible.length < minItems) {
      section.hidden = true;
      return;
    }
    section.hidden = false;

    var chosen = [];
    var eligibleMap = new Map(
      eligible.map(function (x) {
        return [x.id, x];
      })
    );

    function fullPrice() {
      return chosen.reduce(function (sum, id) {
        var p = eligibleMap.get(id);
        return sum + (p ? p.price : 0);
      }, 0);
    }
    function boxPrice() {
      return Math.round(fullPrice() * (1 - pct / 100) * 100) / 100;
    }

    function render() {
      var count = chosen.length;
      var ready = count >= minItems && count <= maxItems;
      var saving = Math.round((fullPrice() - boxPrice()) * 100) / 100;
      var chosenSet = new Set(chosen);

      // Build slot visualizer items
      var trackerHtml = "";
      for (var s = 0; s < maxItems; s++) {
        var isFilled = s < count;
        var isRequired = s < minItems;
        if (isFilled) {
          var chosenId = chosen[s];
          var chosenProd = eligibleMap.get(chosenId);
          var itemThumb =
            (chosenProd && (chosenProd.image || (chosenProd.images && chosenProd.images[0]))) || "";
          trackerHtml +=
            '<span class="custom-box-slot is-filled">' +
            (itemThumb
              ? '<img src="' +
                attrEsc(itemThumb) +
                '" alt="" class="custom-box-slot-thumb" width="20" height="20"> '
              : '<svg class="yl-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg> ') +
            attrEsc(chosenProd ? chosenProd.name.split(" ")[0] : "Item") +
            "</span>";
        } else {
          trackerHtml +=
            '<span class="custom-box-slot' +
            (isRequired ? " is-required" : " is-optional") +
            '">' +
            (isRequired ? "+ Item " + (s + 1) : "+ Optional") +
            "</span>";
        }
      }

      card.innerHTML =
        '<div class="custom-box-head">' +
        '<span class="eyebrow custom-box-badge">✦ BUILD YOUR OWN BOX ✦</span>' +
        '<h2 id="customBoxHeading">Pick &amp; Mix Your Box</h2>' +
        '<p class="muted">Choose any ' +
        minItems +
        (maxItems > minItems ? "&ndash;" + maxItems : "") +
        " handcrafted goods and unlock " +
        pct +
        "% off your entire custom bundle." +
        "</p>" +
        '<div class="custom-box-tracker" aria-label="Box progress">' +
        trackerHtml +
        "</div>" +
        "</div>" +
        '<ul class="custom-box-options" aria-labelledby="customBoxHeading">' +
        eligible
          .map(function (p) {
            var isOn = chosenSet.has(p.id);
            var atLimit = !isOn && count >= maxItems;
            var imgUrl = p.image || (p.images && p.images[0]) || "";
            var catLabel = p.category ? p.category.toUpperCase() : "";
            return (
              '<li><label class="custom-box-option' +
              (isOn ? " is-chosen" : "") +
              (atLimit ? " is-disabled" : "") +
              '">' +
              '<div class="custom-box-option-img-wrap">' +
              (imgUrl
                ? '<img src="' +
                  attrEsc(imgUrl) +
                  '" alt="" class="custom-box-option-img" loading="lazy" width="48" height="48">'
                : '<div class="custom-box-option-img-placeholder"><svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"></path></svg></div>') +
              "</div>" +
              '<div class="custom-box-option-body">' +
              '<span class="custom-box-option-name">' +
              attrEsc(p.name) +
              "</span>" +
              (catLabel
                ? '<span class="custom-box-option-cat">' + attrEsc(catLabel) + "</span>"
                : "") +
              "</div>" +
              '<div class="custom-box-option-meta">' +
              '<span class="custom-box-option-price">$' +
              p.price.toFixed(2) +
              "</span>" +
              '<div class="custom-box-checkbox-wrap">' +
              '<input type="checkbox" value="' +
              attrEsc(p.id) +
              '"' +
              (isOn ? " checked" : "") +
              (atLimit ? " disabled" : "") +
              ">" +
              '<span class="custom-box-check-badge" aria-hidden="true">' +
              '<svg class="yl-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' +
              "</span>" +
              "</div>" +
              "</div>" +
              "</label></li>"
            );
          })
          .join("") +
        "</ul>" +
        '<div class="custom-box-foot">' +
        '<div class="custom-box-summary-block">' +
        '<p class="custom-box-summary" role="status">' +
        (count
          ? '<span class="custom-box-count-pill">' +
            count +
            " of " +
            maxItems +
            " chosen</span> " +
            '<span class="custom-box-price-tag"><s class="custom-box-full-price">$' +
            fullPrice().toFixed(2) +
            "</s> <strong>$" +
            boxPrice().toFixed(2) +
            "</strong></span>" +
            (saving > 0
              ? ' <span class="custom-box-saving">Save $' +
                saving.toFixed(2) +
                " (" +
                pct +
                "% off)</span>"
              : "")
          : '<span class="custom-box-empty-msg">Nothing picked yet &mdash; select at least ' +
            minItems +
            " items to unlock discount.</span>") +
        "</p>" +
        "</div>" +
        '<button type="button" class="btn btn-primary custom-box-btn' +
        (ready ? " is-ready" : "") +
        '" id="customBoxAdd"' +
        (ready ? "" : ' disabled aria-disabled="true"') +
        '><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg> Add Box to Cart</button>' +
        "</div>";
    }

    card.addEventListener("change", function (e) {
      var cb = e.target.closest('input[type="checkbox"]');
      if (!cb) return;
      var id = cb.value;
      var i = chosen.indexOf(id);
      if (cb.checked && i === -1) chosen.push(id);
      else if (!cb.checked && i !== -1) chosen.splice(i, 1);
      render();
      // Re-rendering blows away focus; put it back on the control just used.
      var again = card.querySelector('input[value="' + id.replace(/"/g, '\\"') + '"]');
      if (again) again.focus();
    });

    card.addEventListener("click", function (e) {
      if (!e.target.closest("#customBoxAdd")) return;
      if (chosen.length < minItems || chosen.length > maxItems) return;
      if (!window.YLCart || typeof window.YLCart.addCustomBox !== "function") return;
      window.YLCart.addCustomBox({
        productIds: chosen.slice(),
        price: boxPrice(),
        count: chosen.length
      });
      chosen = [];
      render();
    });

    render();
  }
  initCustomBox();

  /* ---------- Restock / Launch Alert Modal Controller ---------- */
  function openRestockModal(productId, state) {
    state.lastFocusedElement = document.activeElement;

    // Reset state
    if (state.form) {
      state.form.reset();
      state.form.hidden = false;
    }
    if (state.errorSpan) {
      state.errorSpan.textContent = "";
      state.errorSpan.hidden = true;
    }
    if (state.successMsg) state.successMsg.hidden = true;
    if (state.submitBtn) {
      state.submitBtn.disabled = false;
      var btnSpan = state.submitBtn.querySelector("span");
      if (btnSpan) btnSpan.textContent = "Notify Me When Back in Stock";
      else state.submitBtn.textContent = "Notify Me When Back in Stock";
    }

    // Find product details
    var p = getProductMap().get(productId);

    var prodIdInput = document.getElementById("restockProductId");
    var prodNameInput = document.getElementById("restockProductNameInput");
    var nameHeading = document.getElementById("restockProductName");
    var badge = document.getElementById("restockProductBadge");
    var img = document.getElementById("restockProductImg");

    var productName = p ? p.name : productId;
    if (prodIdInput) prodIdInput.value = productId;
    if (prodNameInput) prodNameInput.value = productName;
    if (nameHeading) nameHeading.textContent = productName;

    if (badge) {
      if (p && p.comingSoon) {
        badge.textContent = "Coming Soon";
        badge.className = "stock-badge coming-soon";
      } else {
        badge.textContent = "Sold Out";
        badge.className = "stock-badge sold-out";
      }
    }

    if (img) {
      if (p && p.image) {
        img.src = p.image;
        img.alt = p.name;
        img.hidden = false;
      } else {
        img.hidden = true;
      }
    }

    if (typeof state.modal.showModal === "function") {
      if (!state.modal.open && !state.modal.hasAttribute("open")) {
        state.modal.showModal();
      }
    } else {
      state.modal.setAttribute("open", "true");
    }

    setTimeout(function () {
      if (state.emailInput) state.emailInput.focus();
    }, 50);
  }

  function closeRestockModal(state) {
    if (typeof state.modal.close === "function") {
      state.modal.close();
    } else {
      state.modal.removeAttribute("open");
    }
    if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === "function") {
      state.lastFocusedElement.focus();
    }
  }

  function handleRestockModalKeydown(e, state) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeRestockModal(state);
      return;
    }
    if (e.key === "Tab") {
      var focusables = Array.prototype.filter.call(
        state.modal.querySelectorAll(
          'button:not([disabled]):not([tabindex="-1"]), input:not([type="hidden"]):not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
        ),
        function (el) {
          return !el.closest("[hidden]");
        }
      );
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }

  function handleRestockFormSubmit(e, state) {
    e.preventDefault();

    // Honeypot check
    var hp = document.getElementById("restock-hp-field");
    if (hp && hp.value.trim() !== "") {
      state.form.hidden = true;
      if (state.successMsg) state.successMsg.hidden = false;
      return;
    }

    var email = state.emailInput ? state.emailInput.value.trim() : "";
    var emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailPattern.test(email)) {
      if (state.errorSpan) {
        state.errorSpan.textContent = "Please enter a valid email address.";
        state.errorSpan.hidden = false;
      }
      if (state.emailInput) state.emailInput.focus();
      return;
    }
    if (state.errorSpan) state.errorSpan.hidden = true;

    var site = (window.YL_CONTENT && window.YL_CONTENT.site) || {};
    var formId = site.formspreeRestockId || "YOUR_FORMSPREE_RESTOCK_ID";

    if (formId === "YOUR_FORMSPREE_RESTOCK_ID") {
      showFormFallback(
        state.form,
        "Restock alerts aren't connected yet -- you haven't been added to a list. Email us and we'll tell you when it lands: ",
        "y.allternative.living@gmail.com"
      );
      return;
    }

    if (state.submitBtn) {
      state.submitBtn.disabled = true;
      var btnSpan = state.submitBtn.querySelector("span");
      if (btnSpan) btnSpan.textContent = "Saving…";
      else state.submitBtn.textContent = "Saving…";
    }

    fetch("https://formspree.io/f/" + formId, {
      method: "POST",
      body: new FormData(state.form),
      headers: { Accept: "application/json" }
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Signup failed");
        state.form.hidden = true;
        if (state.successMsg) state.successMsg.hidden = false;
      })
      .catch(function () {
        if (state.submitBtn) {
          state.submitBtn.disabled = false;
          var btnSpan = state.submitBtn.querySelector("span");
          if (btnSpan) btnSpan.textContent = "Notify Me When Back in Stock";
          else state.submitBtn.textContent = "Notify Me When Back in Stock";
        }
        showFormFallback(
          state.form,
          "That didn't go through. Please email us instead: ",
          "y.allternative.living@gmail.com"
        );
      });
  }

  function setupRestockAlertModalTriggers(state) {
    document.addEventListener("click", function (e) {
      var toggle = e.target.closest(".yl-notify-toggle");
      if (toggle) {
        e.preventDefault();
        var productId = toggle.getAttribute("data-notify-for");
        if (productId) openRestockModal(productId, state);
        return;
      }

      var closeBtn = e.target.closest(
        '#closeRestockModalBtn, [data-action="close-restock-modal"], #restockDoneBtn'
      );
      if (closeBtn) {
        e.preventDefault();
        closeRestockModal(state);
      }
    });

    state.modal.addEventListener("click", function (e) {
      if (e.target === state.modal) {
        closeRestockModal(state);
      }
    });

    state.modal.addEventListener("keydown", function (e) {
      handleRestockModalKeydown(e, state);
    });

    if (state.form) {
      state.form.addEventListener("submit", function (e) {
        handleRestockFormSubmit(e, state);
      });
    }
  }

  function initRestockAlertModal() {
    var modal = document.getElementById("restock-alert-modal");
    if (!modal) return;

    var state = {
      modal: modal,
      lastFocusedElement: null,
      form: document.getElementById("restockAlertForm"),
      emailInput: document.getElementById("restock-email-input"),
      errorSpan: document.getElementById("restockEmailError"),
      successMsg: document.getElementById("restockSuccessMessage"),
      submitBtn: document.getElementById("restockSubmitBtn")
    };

    setupRestockAlertModalTriggers(state);
  }
  initRestockAlertModal();

  /* Keyboard activation for the gallery slides exposed as role="button"
     above. Native buttons fire click on Enter and Space for free; an element
     with role="button" has to do it by hand, and Space additionally needs its
     default page-scroll suppressed. Delegated to match the click handler, so
     it covers cards rendered now or re-rendered after a filter/sort. */
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    var slide = e.target.closest && e.target.closest(".card-gallery-slide");
    if (!slide) return;
    e.preventDefault();
    slide.click();
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
     both the visible price and the Add to Cart button's data-item-price /
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
    var loyalty = getLoyaltyConfig();
    var pointsValEl = card.querySelector(".alt-points-badge .pts-val");
    if (pointsValEl) {
      pointsValEl.textContent = Math.floor(newPrice * loyalty.rate);
    } else {
      var pointsTag = card.querySelector(".alt-points-badge");
      if (pointsTag) {
        pointsTag.textContent =
          loyalty.emoji + " Earn " + Math.floor(newPrice * loyalty.rate) + " " + loyalty.name;
      }
    }
    var addBtn = card.querySelector(".yl-add-item");
    if (addBtn) {
      addBtn.setAttribute("data-item-custom1-value", opt.value);
    }
  });

  /* ---------- Conversion tracking (custom events) ----------
     Analytics only sees pageviews out of the box -- with no event
     tracking, there's no way to tell "people are visiting" from "people
     actually want to buy something." This fires a lightweight custom
     event on every Add to Cart click with the product name as a prop,
     so the real, once-deployed dashboard can show which products people
     are actually trying to buy, not just which pages get looked at.
     window.plausible here is the analytics adapter defined at the top of
     this file (it forwards to Umami's umami.track); it always exists, and
     guarded here since it won't exist at all when testing locally over
     file:// (no network) or for anyone running an ad/tracker blocker --
     either way this must never throw or block the actual add-to-cart. */
  document.addEventListener("click", function (e) {
    var btn = e.target.closest(".yl-add-item");
    if (!btn || typeof window.plausible !== "function") return;
    window.plausible("Add to Cart", {
      props: {
        product: btn.getAttribute("data-item-name") || btn.getAttribute("data-item-id") || "unknown"
      }
    });
  });
  /* The one event that actually matters more than "added to cart" is
     "paid". That fires from thank-you.html (the Stripe success redirect
     target, see workers/checkout.js's success_url) rather than from here --
     unlike Snipcart's in-page cart.confirmed event, Stripe Checkout is a
     full-page navigation away and back, so there's no in-page event to
     listen for. See thank-you.html's own inline script. */

  /* ---------- Tag pills HTML ---------- */
  var TAG_LABELS = {
    vegan:
      '<svg class="yl-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"></path><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"></path></svg>Vegan',
    unscented:
      '<svg class="yl-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/></svg>Unscented',
    "essential-oil-free":
      '<svg class="yl-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/></svg>EO-Free',
    "sensitive-safe":
      '<svg class="yl-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>Sensitive Safe',
    "cruelty-free":
      '<svg class="yl-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>Cruelty-Free',
    organic:
      '<svg class="yl-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 3.5 1 9.8a7 7 0 0 1-9 8.2Z"/><path d="M19 2c-2.26 4.33-5.27 7.14-8 10"/></svg>Organic',
    "locally-sourced":
      '<svg class="yl-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>Locally Sourced'
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
      handlePickupMarketDeepLink();

      // A live-inventory overlay used to fetch real-time stock levels from
      // Snipcart's product API here (/.netlify/functions/inventory) and
      // patch them over the static products.json numbers. That endpoint
      // went away with Snipcart -- stock is now whatever's set on each
      // product in assets/data/products.json (editable via the Sveltia CMS
      // at /admin), refreshed on every deploy like the rest of the catalog.
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
    if (!Array.isArray(products)) return [];
    return products.filter(function (p) {
      return p.featured === true;
    });
  }

  /* ---------- Bundles / gift sets (shop.html only) ----------
     Real component products at a computed discount -- see products-data.js
     "bundles" array for the full rationale. Each bundle checks out as its
     own single cart line item (id "bundle-<id>"), priced by
     scripts/build-site-data.js from the same real product prices this
     function reads, so the on-page math and the checkout price can never
     disagree. */
  function bundlesHTML(bundles, productsById) {
    var pMap = getProductMap();
    var isMap = productsById && typeof productsById.get === "function";
    return bundles
      .map(function (b) {
        var items = b.productIds
          .map(function (id) {
            if (isMap) {
              return productsById.get(id);
            }
            return productsById && productsById[id] ? productsById[id] : pMap.get(id);
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
          '<button type="button" class="btn btn-primary btn-sm yl-add-item"' +
          ' data-item-id="bundle-' +
          attrEsc(b.id) +
          '"' +
          ' data-item-name="' +
          attrEsc(b.name) +
          '"' +
          ' data-item-price="' +
          bundlePrice.toFixed(2) +
          '"' +
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

  function renderBundles(data, query, concern) {
    var bundlesList = document.getElementById("bundlesList");
    var bundlesSection = document.querySelector(".bundles-section");
    if (!bundlesList) return;
    if (!data.bundles || !data.bundles.length) {
      if (bundlesSection) bundlesSection.style.display = "none";
      return;
    }
    var pMap = getProductMap();
    var q = (query || "").trim().toLowerCase();
    var c = (concern || "all").trim();
    var filteredBundles = data.bundles.filter(function (b) {
      if (c !== "all") {
        if (!Array.isArray(b.concerns) || !b.concerns.includes(c)) return false;
      }
      if (!q) return true;
      var haystack = (
        b.name +
        " " +
        b.blurb +
        " " +
        b.productIds
          .map(function (id) {
            var p = pMap.get(id);
            return p ? p.name : "";
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
    bundlesList.innerHTML = bundlesHTML(filteredBundles, pMap);
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
    /* "Show Botanical Ingredients Info" in the CMS was read by nothing, so the
       disclosure was permanently on. Gated here rather than by a build-time
       style rule because these cards are rendered by JS -- skipping the markup
       outright is cheaper than emitting it and hiding it. Defaults to on when
       the flag is absent, matching the CMS default. */
    var site = (window.YL_CONTENT && window.YL_CONTENT.site) || {};
    if (site.enableIngredientsModal === false) return "";
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

  function getLoyaltyConfig() {
    var site = (window.YL_CONTENT && window.YL_CONTENT.site) || {};
    return {
      name: site.loyaltyPointsName || "Alt-Points",
      singular: site.loyaltyPointsSingular || "Alt-Point",
      rate: Number(site.loyaltyPointsPerDollar) > 0 ? Number(site.loyaltyPointsPerDollar) : 1,
      emoji: site.loyaltyBadgeEmoji || "✨",
      enabled: site.enableLoyaltyPoints !== false
    };
  }

  function getDispatchBadgeHTML(p) {
    var site = (window.YL_CONTENT && window.YL_CONTENT.site) || {};
    if (site.enableDispatchCountdown === false) return "";
    if (p.id === "yallternative-gift-card" || p.comingSoon) return "";

    var now = new Date();
    var formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour12: false,
      hour: "numeric",
      minute: "numeric",
      weekday: "short"
    });
    var parts = formatter.formatToParts(now);
    var partMap = {};
    parts.forEach(function (pt) {
      partMap[pt.type] = pt.value;
    });

    var hour = parseInt(partMap.hour, 10);
    var minute = parseInt(partMap.minute, 10);

    // Landrum, SC 2:00 PM (14:00) ET cutoff
    var diffMins;
    if (hour < 14) {
      diffMins = 14 * 60 - (hour * 60 + minute);
    } else {
      diffMins = 24 * 60 - (hour * 60 + minute) + 14 * 60;
    }
    var h = Math.floor(diffMins / 60);
    var m = diffMins % 60;

    var zapIcon =
      '<svg class="yl-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>';
    var text = "Order within " + h + "h " + m + "m for dispatch tomorrow";

    return (
      '<div class="dispatch-badge-wrap">' +
      '<span class="dispatch-badge">' +
      zapIcon +
      " " +
      attrEsc(text) +
      "</span>" +
      "</div>"
    );
  }

  function cardHTML(p, opts) {
    opts = opts || {};
    var loyalty = getLoyaltyConfig();
    /* 0 means the owner switched free shipping off in the CMS ("Set to 0 to
       disable"), which the announcement bar and the checkout Worker both
       honour -- so the card must drop the promise rather than fall back to
       the default and advertise a tier Stripe will no longer give. Only a
       missing/non-numeric value falls back. */
    var rawFreeShip =
      window.YL_PRODUCTS && window.YL_PRODUCTS.shop
        ? window.YL_PRODUCTS.shop.freeShippingThreshold
        : undefined;
    var freeShipThreshold =
      rawFreeShip === null || rawFreeShip === undefined || rawFreeShip === ""
        ? 40
        : isFinite(Number(rawFreeShip))
          ? Number(rawFreeShip)
          : 40;
    var pointsBadgeHTML = loyalty.enabled
      ? '<div style="text-align: center; margin-bottom: 8px;"><span class="alt-points-badge">' +
        attrEsc(loyalty.emoji) +
        ' Earn <span class="pts-val">' +
        Math.floor(p.price * loyalty.rate) +
        "</span> " +
        attrEsc(loyalty.name) +
        "</span></div>"
      : "";
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
      attrEsc(catLabel) +
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
      (function () {
        var vRule = getMatchingVolumeRule(p);
        if (!vRule) return "";
        var baseFormatted = "$" + p.price.toFixed(2) + " each";
        var promoFormatted =
          vRule.label ||
          vRule.minQuantity + "+ for $" + Number(vRule.unitPrice).toFixed(2) + " each";
        return (
          '<p class="volume-pricing-note" style="font-size: 0.75rem; color: var(--whiskey); margin: 0 0 6px 0; text-align: center; font-weight: 600;">' +
          baseFormatted +
          " · " +
          attrEsc(promoFormatted) +
          " (Mix &amp; Match)</p>"
        );
      })() +
      (p.id !== "yallternative-gift-card" && freeShipThreshold > 0
        ? '<p style="font-size: 0.72rem; color: var(--whiskey); margin: 0 0 6px 0; text-align: center; font-weight: 600;">Free shipping over $' +
          freeShipThreshold +
          "</p>"
        : "") +
      getDispatchBadgeHTML(p) +
      pointsBadgeHTML +
      '<div class="card-foot-row">' +
      priceHTML(p) +
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
    if (!products || !products.length) {
      container.innerHTML =
        /* --paper-dim is a TEXT colour, not a surface (see the palette at the
           top of styles.css). Used as a background here it painted a light tan
           panel, and the body copy below is --paper-muted, which resolves to
           that same --paper-dim -- identical foreground and background, so the
           "we couldn't find anything" message was invisible. Only ever visible
           on a zero-result search, which is why it survived this long. */
        '<div class="yl-no-results" style="grid-column: 1 / -1; text-align: center; padding: 3rem 1.5rem; background: var(--ink-2); border: 1px dashed var(--hide); border-radius: var(--radius-md); margin: 1rem 0;">' +
        '  <span style="display: flex; justify-content: center; margin-bottom: 0.75rem;"><svg class="yl-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color: var(--whiskey);"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg></span>' +
        '  <h3 style="font-family: var(--font-display); margin-bottom: 0.5rem; color: var(--whiskey);">No Apothecary Items Found</h3>' +
        '  <p style="color: var(--paper-dim); max-width: 420px; margin: 0 auto 1.25rem; font-size: 0.9rem;">We couldn\'t find any salves, soaks, or goods matching your search or active filter.</p>' +
        '  <button type="button" class="btn btn-outline btn-sm" id="resetFiltersBtn">Reset Filters & Search</button>' +
        "</div>";
      var resetBtn = container.querySelector("#resetFiltersBtn");
      if (resetBtn) {
        resetBtn.addEventListener("click", function () {
          var searchInput =
            document.getElementById("shopSearch") || document.getElementById("shopSearchInput");
          if (searchInput) {
            searchInput.value = "";
            searchInput.dispatchEvent(new Event("input"));
          }
          var allPill = document.querySelector('.filter-pill[data-filter="all"]');
          if (allPill) {
            allPill.click();
          }
          var allConcernPill = document.querySelector('.concern-pill[data-concern="all"]');
          if (allConcernPill) {
            allConcernPill.click();
          }
          var scentSelect = document.getElementById("scentSelect");
          if (scentSelect) {
            scentSelect.value = "all";
            scentSelect.dispatchEvent(new Event("change"));
          }
        });
      }
      return;
    }
    container.innerHTML = products
      .map(function (p, i) {
        return cardHTML(p, { eager: eagerFirst && i < EAGER_CARD_COUNT });
      })
      .join("");
    wireReveal(container);
  }

  /* ---------- Customer Reviews Engine & Filter Helpers (reviews.html & shop.html) ---------- */
  function formatReviewDate(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return "";
    var d = new Date(iso + "T00:00:00");
    return isNaN(d.getTime())
      ? ""
      : d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }

  function filterReviews(reviews, query, rating, productsById) {
    if (!Array.isArray(reviews)) return [];
    var q = (query || "").trim().toLowerCase();
    var rTarget = rating && rating !== "all" ? parseInt(rating, 10) : null;
    productsById = productsById || {};

    return reviews.filter(function (r) {
      if (!r) return false;
      if (rTarget !== null && Math.round(r.rating) !== rTarget) {
        return false;
      }
      if (q) {
        var textMatch = (r.text || "").toLowerCase().indexOf(q) !== -1;
        var nameMatch = (r.name || "").toLowerCase().indexOf(q) !== -1;
        var product = r.productId && productsById[r.productId];
        var prodNameMatch = product && (product.name || "").toLowerCase().indexOf(q) !== -1;
        var prodCatMatch = product && (product.category || "").toLowerCase().indexOf(q) !== -1;
        if (!textMatch && !nameMatch && !prodNameMatch && !prodCatMatch) {
          return false;
        }
      }
      return true;
    });
  }

  function renderReviewCardHtml(r, product) {
    if (!r) return "";
    var full = Math.max(0, Math.min(5, Math.round(r.rating || 0)));
    var stars = "";
    for (var i = 0; i < 5; i++) stars += i < full ? "★" : "☆";

    var verifiedBadgeHtml = r.verifiedBuyer
      ? '<span class="badge badge-verified" title="Verified Customer">' +
        '<svg class="icon-badge-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l3.09 2.22 3.79-.37 1.83 3.32 3.24 1.98-.79 3.72.79 3.72-3.24 1.98-1.83 3.32-3.79-.37L12 22l-3.09-2.22-3.79.37-1.83-3.32-3.24-1.98.79-3.72-.79-3.72 3.24-1.98 1.83-3.32 3.79.37L12 2z"/><polyline points="9 12 11 14 15 10"/></svg>' +
        " Verified Buyer</span>"
      : "";

    var byline =
      attrEsc(r.name || "A customer") +
      (product ? " · " + attrEsc(product.name) : "") +
      (r.date ? " · " + formatReviewDate(r.date) : "");

    return (
      '<div class="quote-card review-card reveal">' +
      '<div class="review-card-top">' +
      '<span class="stars" aria-hidden="true">' +
      stars +
      "</span>" +
      '<span class="sr-only">Rated ' +
      attrEsc(r.rating) +
      " out of 5 stars.</span>" +
      verifiedBadgeHtml +
      "</div>" +
      "<p>&ldquo;" +
      attrEsc(r.text || "") +
      "&rdquo;</p>" +
      "<footer>" +
      byline +
      "</footer>" +
      "</div>"
    );
  }

  function initReviewsEngine() {
    var reviewsGrid =
      document.getElementById("reviewsGrid") || document.getElementById("siteReviewsList");
    if (!reviewsGrid) return;

    var searchInput = document.getElementById("reviewSearchInput");
    var ratingChips = document.querySelectorAll(".review-rating-chips button");
    var countBanner = document.getElementById("reviewsCountBanner");
    var emptyState = document.getElementById("reviewsEmptyState");
    var resetBtn = document.getElementById("reviewsResetBtn");

    var productsById = {};
    ((window.YL_PRODUCTS && window.YL_PRODUCTS.products) || []).forEach(function (p) {
      productsById[p.id] = p;
    });

    var allReviews = (window.YL_SITE_REVIEWS || []).slice().sort(function (a, b) {
      return (b.date || "").localeCompare(a.date || "");
    });

    var currentRating = "all";
    var currentQuery = "";

    function updateView() {
      var filtered = filterReviews(allReviews, currentQuery, currentRating, productsById);

      if (countBanner) {
        var countText =
          "Showing " + filtered.length + (filtered.length === 1 ? " review" : " reviews");
        var q = currentQuery.trim();
        if (q) {
          countText += ' matching "' + q + '"';
        }
        if (currentRating !== "all") {
          countText += " (" + currentRating + "★ only)";
        }
        countBanner.textContent = countText;
      }

      if (filtered.length === 0) {
        reviewsGrid.innerHTML = "";
        if (emptyState) emptyState.hidden = false;
      } else {
        if (emptyState) emptyState.hidden = true;
        reviewsGrid.innerHTML = filtered
          .map(function (r) {
            var product = r.productId && productsById[r.productId];
            return renderReviewCardHtml(r, product);
          })
          .join("");
        wireReveal(reviewsGrid);
      }

      var legacyEmpty = document.getElementById("siteReviewsEmpty");
      if (legacyEmpty) {
        legacyEmpty.style.display = filtered.length ? "none" : "block";
      }
    }

    if (searchInput) {
      searchInput.addEventListener("input", function () {
        currentQuery = searchInput.value;
        updateView();
      });
    }

    if (ratingChips && ratingChips.length) {
      ratingChips.forEach(function (btn) {
        btn.addEventListener("click", function () {
          ratingChips.forEach(function (b) {
            b.classList.remove("active");
            b.setAttribute("aria-pressed", "false");
          });
          btn.classList.add("active");
          btn.setAttribute("aria-pressed", "true");
          currentRating = btn.getAttribute("data-rating") || "all";
          updateView();
        });
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        currentQuery = "";
        currentRating = "all";
        if (searchInput) searchInput.value = "";
        if (ratingChips && ratingChips.length) {
          ratingChips.forEach(function (b) {
            var isAll = (b.getAttribute("data-rating") || "") === "all";
            b.classList.toggle("active", isAll);
            b.setAttribute("aria-pressed", isAll ? "true" : "false");
          });
        }
        updateView();
      });
    }

    // Initial render
    updateView();

    // Product picker for review form
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
  initReviewsEngine();

  /* ---------- Milestone 6: Dedicated Order Status Page Controller ---------- */
  function maskEmail(email) {
    var parts = String(email).split("@");
    if (parts.length !== 2) return email;
    var user = parts[0];
    var domain = parts[1];
    var maskedUser = user.length > 2 ? user[0] + "***" + user.slice(-1) : user + "*";
    var dParts = domain.split(".");
    var dName = dParts[0];
    var dExt = dParts.slice(1).join(".");
    var maskedDomain =
      (dName.length > 2 ? dName[0] + "***" + dName.slice(-1) : dName) + (dExt ? "." + dExt : "");
    return maskedUser + "@" + maskedDomain;
  }

  function parseOrderStatusQuery(val) {
    var str = String(val || "").trim();
    if (!str) return null;
    var isSessionId = /^cs_[a-zA-Z0-9_]+/i.test(str);
    var isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
    var isOrderRef = /^(YL-|ORD-)[a-zA-Z0-9_-]+/i.test(str);
    if (!isSessionId && !isEmail && !isOrderRef) return null;
    return {
      query: str,
      isSessionId: isSessionId,
      isEmail: isEmail,
      isOrderRef: isOrderRef,
      displayId: isEmail ? maskEmail(str) : str.length > 28 ? str.substring(0, 28) + "..." : str
    };
  }

  /* ---------- Order status: the honest lookup ----------
     There is no order API on this site. The page used to answer any
     syntactically plausible string with "Order Confirmed, payment processed
     securely via Stripe", a four-step fulfilment timeline, a hardcoded
     two-item order and a printable packing slip -- none of it fetched from
     anywhere, all of it fabricated for whatever the visitor typed. It also
     reflected `?email=` straight back into the input and let a "Reorder"
     button push those invented items into the real cart.

     What the site can honestly offer is what the old fallback branch already
     said: mail the reference to a human. That is now the only branch. The
     reference is pre-filled into the mail subject so the customer does not
     have to retype it, and the reply window is stated up front. */
  function orderStatusMailtoHref(reference) {
    var subject = reference ? "Order status: " + reference : "Order status request";
    return "mailto:y.allternative.living@gmail.com?subject=" + attrEsc(encodeURIComponent(subject));
  }

  function orderStatusFallbackHTML(reference) {
    var safeRef = attrEsc(reference || "");
    return (
      '<div class="order-lookup-unavailable" role="status">' +
      "<h3>We look this one up by hand</h3>" +
      "<p>Order tracking isn&rsquo;t automated here &mdash; every batch is made and boxed by one " +
      "person, and every lookup is answered by that same person. " +
      (safeRef ? "Send us <strong>" + safeRef + "</strong> " : "Send us your order reference ") +
      "and we&rsquo;ll check where it stands and write back " +
      "<strong>within one business day</strong>.</p>" +
      '<p><a class="btn btn-primary" href="' +
      orderStatusMailtoHref(reference) +
      '">Email us about this order</a></p>' +
      '<p class="muted">Prefer to write it yourself? We\'re at ' +
      '<a href="mailto:y.allternative.living@gmail.com">y.allternative.living@gmail.com</a>.</p>' +
      "</div>"
    );
  }

  function initOrderStatusPage() {
    var form = document.getElementById("orderStatusPageForm");
    var input = document.getElementById("orderQueryInput");
    var errorDiv = document.getElementById("orderStatusError");
    var resultSection = document.getElementById("orderStatusResultSection");
    var lookupCard = document.getElementById("orderStatusLookupCard");
    var timelineContainer = document.getElementById("orderTimelineContainer");

    if (!form && !timelineContainer) return;

    /* content.json's switch used to be read by nothing at all, so turning the
       tool off in /admin left it fully working. Off now means: no form, and
       the contact route shown in its place rather than a dead page. */
    if (!siteFlagEnabled("enableOrderStatusLookup")) {
      if (lookupCard) {
        lookupCard.hidden = true;
        lookupCard.setAttribute("hidden", "");
      }
      if (resultSection) resultSection.hidden = false;
      if (timelineContainer) timelineContainer.innerHTML = orderStatusFallbackHTML("");
      return;
    }

    function handleLookup(queryVal) {
      var val = String(queryVal == null ? (input && input.value) || "" : queryVal).trim();
      if (!val) {
        if (errorDiv) {
          errorDiv.textContent = "Please enter your order reference number.";
          errorDiv.hidden = false;
        }
        return false;
      }
      if (errorDiv) errorDiv.hidden = true;

      /* Same shape validation as before -- a Stripe session id, an order
         reference or an email address. An email is masked before it is shown
         back, so a shared screen never repeats the address in full. */
      var parsed = parseOrderStatusQuery(val);
      var display = parsed
        ? parsed.displayId
        : val.length > 28
          ? val.substring(0, 28) + "..."
          : val;

      if (resultSection) resultSection.hidden = false;
      if (timelineContainer) timelineContainer.innerHTML = orderStatusFallbackHTML(display);
      return true;
    }

    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        handleLookup(input ? input.value : "");
      });
    }

    /* Only the Stripe session id may pre-fill, and it never submits. `?email=`
       and `?q=` used to be reflected into the field and looked up on load,
       which put a customer's address on screen (and into any screenshot or
       shared link) without them typing it. */
    try {
      if (typeof window !== "undefined" && window.location && window.location.search) {
        var urlParams = new URLSearchParams(window.location.search);
        var sessionParam = urlParams.get("session_id");
        if (sessionParam && input && /^cs_[a-zA-Z0-9_]+$/.test(sessionParam)) {
          input.value = sessionParam;
        }
      }
    } catch (e) {
      void e;
    }
  }
  initOrderStatusPage();

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
      // Multi-day events stay listed through their final day (endDate); the
      // countdown still targets the start date so it counts down to opening.
      var evCutoff = ev.endDate || ev.date;
      if (evCutoff && evCutoff < todayStr) {
        past.push(ev);
      } else {
        upcoming.push(ev);
      }
    });

    rawPast.forEach(function (ev) {
      past.push(ev);
    });

    if (upcomingEl) {
      // Decorate-sort-undecorate: parse each date once (O(n)) instead of
      // allocating two Date objects on every comparison (O(n log n)).
      var sortedUpcoming = upcoming
        .map(function (ev) {
          return { ev: ev, t: new Date(ev.date).getTime() };
        })
        .sort(function (a, b) {
          return a.t - b.t;
        })
        .map(function (x) {
          return x.ev;
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
          '<a class="btn btn-primary" href="https://www.instagram.com/yallternativeliving" target="_blank" rel="noopener">Instagram ↗<span class="sr-only"> (opens in new tab)</span></a>' +
          '<a class="btn btn-outline" href="https://www.tiktok.com/@yallternativeliving" target="_blank" rel="noopener">TikTok ↗<span class="sr-only"> (opens in new tab)</span></a>' +
          "</div>" +
          "</div>";
      }
      markReveal(upcomingEl);
    }

    if (pastEl) {
      // Sort past events: most recent first
      // Decorate-sort-undecorate: parse each date once (O(n)) instead of
      // allocating two Date objects on every comparison (O(n log n)).
      var sortedPast = past
        .map(function (ev) {
          return { ev: ev, t: new Date(ev.date || "1970-01-01").getTime() };
        })
        .sort(function (a, b) {
          return b.t - a.t;
        })
        .map(function (x) {
          return x.ev;
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

  function getWrappedIndex(index, length) {
    return ((index % length) + length) % length;
  }

  function setupCarouselInteraction(container, onPause, onResume) {
    container.addEventListener("mouseenter", onPause);
    container.addEventListener("mouseleave", onResume);
    container.addEventListener("focusin", onPause);
    container.addEventListener("focusout", onResume);
  }

  function setupCarouselNavigation(container, dots, inner, onRelativeNav, onAbsoluteNav) {
    var prev = container.querySelector(".carousel-prev");
    var next = container.querySelector(".carousel-next");
    if (prev) {
      prev.addEventListener("click", function () {
        onRelativeNav(-1);
      });
    }
    if (next) {
      next.addEventListener("click", function () {
        onRelativeNav(1);
      });
    }

    dots.forEach(function (dot) {
      dot.addEventListener("click", function () {
        onAbsoluteNav(parseInt(this.getAttribute("data-index"), 10));
      });
    });

    attachSwipe(
      inner,
      function () {
        onRelativeNav(1); // swipe left (next)
      },
      function () {
        onRelativeNav(-1); // swipe right (prev)
      }
    );
  }

  function createAutoplayManager(onTick, interval) {
    var intervalId;
    return {
      start: function () {
        this.stop();
        intervalId = setInterval(onTick, interval);
      },
      stop: function () {
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      }
    };
  }

  function setupPastEventsRotation(container) {
    var inner = container.querySelector(".events-carousel-inner");
    var cards = container.querySelectorAll(".event-card");
    var dots = container.querySelectorAll(".carousel-dot");
    if (!inner || cards.length <= 1) return;

    var currentIndex = 0;
    var paused = false;

    var autoplay = createAutoplayManager(function () {
      if (!container.querySelector(".events-carousel-inner")) {
        autoplay.stop();
        return;
      }
      if (!paused) goToIndex(currentIndex + 1);
    }, 4000);

    function goToIndex(index) {
      if (!container.querySelector(".events-carousel-inner")) return;
      cards[currentIndex].classList.remove("active");
      if (dots[currentIndex]) dots[currentIndex].classList.remove("active");

      currentIndex = getWrappedIndex(index, cards.length);

      cards[currentIndex].classList.add("active");
      if (dots[currentIndex]) dots[currentIndex].classList.add("active");
      inner.style.transform = "translateX(-" + currentIndex * 100 + "%)";
    }

    function enterCarouselMode() {
      currentIndex = 0;
      inner.style.transform = "translateX(0)";
      for (var i = 0; i < cards.length; i++) cards[i].classList.remove("active");
      cards[0].classList.add("active");
      for (var j = 0; j < dots.length; j++) dots[j].classList.remove("active");
      if (dots[0]) dots[0].classList.add("active");
      autoplay.start();
    }

    function exitCarouselMode() {
      autoplay.stop();
      inner.style.transform = "";
      for (var i = 0; i < cards.length; i++) cards[i].classList.remove("active");
    }

    var mql = window.matchMedia("(max-width: 768px)");
    mql.addEventListener("change", function () {
      if (mql.matches) {
        enterCarouselMode();
      } else {
        exitCarouselMode();
      }
    });

    setupCarouselInteraction(
      container,
      function () {
        paused = true;
      },
      function () {
        paused = false;
      }
    );

    setupCarouselNavigation(
      container,
      dots,
      inner,
      function (delta) {
        goToIndex(currentIndex + delta);
        autoplay.start();
      },
      function (index) {
        goToIndex(index);
        autoplay.start();
      }
    );

    if (mql.matches) {
      enterCarouselMode();
    }
  }

  /* ---------- Calendar & Event Utility Functions (Milestone 2) ---------- */
  function getEventDateParts(dateStr) {
    if (!dateStr) return null;
    var dateOnly = String(dateStr).slice(0, 10);
    var parts = dateOnly.split("-").map(Number);
    if (parts.length !== 3 || isNaN(parts[0]) || isNaN(parts[1]) || isNaN(parts[2])) {
      return null;
    }
    var y = String(parts[0]);
    var m = String(parts[1]).padStart(2, "0");
    var d = String(parts[2]).padStart(2, "0");
    return {
      year: parts[0],
      month: parts[1],
      day: parts[2],
      str: y + m + d
    };
  }

  function getNextDayStr(dateStr) {
    var p = getEventDateParts(dateStr);
    if (!p) return "";
    var d = new Date(Date.UTC(p.year, p.month - 1, p.day));
    d.setUTCDate(d.getUTCDate() + 1);
    var y = d.getUTCFullYear();
    var m = String(d.getUTCMonth() + 1).padStart(2, "0");
    var day = String(d.getUTCDate()).padStart(2, "0");
    return "" + y + m + day;
  }

  function getCalendarDates(ev) {
    var startP = getEventDateParts(ev && ev.date);
    var startStr = startP ? startP.str : "";
    var lastDayStr =
      ev && (ev.endDate || ev.date) ? String(ev.endDate || ev.date).slice(0, 10) : "";
    var endStr = lastDayStr ? getNextDayStr(lastDayStr) : startStr;
    return { start: startStr, end: endStr };
  }

  function generateGoogleCalendarUrl(ev) {
    if (!ev) return "";
    var dates = getCalendarDates(ev);
    var title =
      ev.name && ev.name.indexOf("Y'allternative") !== -1
        ? ev.name
        : "Y'allternative Living at " + (ev.name || "Pop-Up Market");
    var details = ev.note || "Handmade small-batch apothecary goods & apparel.";
    if (ev.url) {
      details += "\n\nMore info: " + ev.url;
    }
    var location = ev.location
      ? ev.name
        ? ev.name + ", " + ev.location
        : ev.location
      : "Landrum, SC";
    if (ev.note && ev.zip && ev.note.indexOf(ev.zip) !== -1) {
      var match = ev.note.match(/^([^.]+?\b\d{5}\b)/);
      if (match) location = match[1].trim();
    }

    return (
      "https://calendar.google.com/calendar/render?action=TEMPLATE" +
      "&text=" +
      encodeURIComponent(title) +
      "&dates=" +
      dates.start +
      "/" +
      dates.end +
      "&details=" +
      encodeURIComponent(details) +
      "&location=" +
      encodeURIComponent(location)
    );
  }

  function escapeIcsText(str) {
    if (!str) return "";
    return String(str)
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r?\n/g, "\\n");
  }

  function generateIcsContent(ev) {
    if (!ev) return "";
    var dates = getCalendarDates(ev);
    var title =
      ev.name && ev.name.indexOf("Y'allternative") !== -1
        ? ev.name
        : "Y'allternative Living at " + (ev.name || "Pop-Up Market");
    var slug = (ev.id || ev.name || "event")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    var uid = "yl-event-" + (slug || "market") + "-" + dates.start + "@yallternativeliving.com";
    var dtstamp = "20260901T000000Z";
    var description = ev.note || "Handmade small-batch apothecary goods & apparel in Landrum, SC.";
    if (ev.url) {
      description += " More info: " + ev.url;
    }
    var location = ev.location
      ? ev.name
        ? ev.name + ", " + ev.location
        : ev.location
      : "Landrum, SC";
    if (ev.note && ev.zip && ev.note.indexOf(ev.zip) !== -1) {
      var match = ev.note.match(/^([^.]+?\b\d{5}\b)/);
      if (match) location = match[1].trim();
    }

    var lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Y'allternative Living//Pop-Up Calendar//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      "UID:" + uid,
      "DTSTAMP:" + dtstamp,
      "DTSTART;VALUE=DATE:" + dates.start,
      "DTEND;VALUE=DATE:" + dates.end,
      "SUMMARY:" + escapeIcsText(title),
      "DESCRIPTION:" + escapeIcsText(description),
      "LOCATION:" + escapeIcsText(location),
      "STATUS:CONFIRMED",
      "END:VEVENT",
      "END:VCALENDAR"
    ];
    return lines.join("\r\n");
  }

  function generateIcsDataUri(ev) {
    var content = generateIcsContent(ev);
    if (!content) return "";
    return "data:text/calendar;charset=utf-8," + encodeURIComponent(content);
  }

  function getEventIcsFilename(ev) {
    var slug = ((ev && (ev.id || ev.name)) || "event")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return (slug || "event") + ".ics";
  }

  function formatEventMapDestination(ev) {
    if (!ev) return "Landrum, SC";
    if (ev.note && ev.zip && ev.note.indexOf(ev.zip) !== -1) {
      var match = ev.note.match(/^([^.]+?\b\d{5}\b)/);
      if (match) return match[1].trim();
    }
    var parts = [];
    if (ev.name) parts.push(ev.name);
    if (ev.location) parts.push(ev.location);
    if (ev.zip && (!ev.location || ev.location.indexOf(ev.zip) === -1)) parts.push(ev.zip);
    return parts.length ? parts.join(", ") : "Landrum, SC";
  }

  function generateGoogleMapsDirUrl(ev) {
    var dest = formatEventMapDestination(ev);
    return "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(dest);
  }

  function generateAppleMapsDirUrl(ev) {
    var dest = formatEventMapDestination(ev);
    return "https://maps.apple.com/?daddr=" + encodeURIComponent(dest);
  }

  function parsePickupMarketParam(param, events) {
    if (!param) return null;
    var decoded = decodeURIComponent(param).trim();
    var list = (events && events.upcoming) || [];
    for (var i = 0; i < list.length; i++) {
      var ev = list[i];
      var label =
        (ev.name || "Pop-up Market") +
        " — " +
        (ev.dateLabel || "") +
        " (" +
        (ev.location || "Landrum, SC") +
        ")";
      if (
        (ev.id && ev.id.toLowerCase() === decoded.toLowerCase()) ||
        (ev.name && ev.name.toLowerCase() === decoded.toLowerCase()) ||
        label.toLowerCase() === decoded.toLowerCase() ||
        label.toLowerCase().indexOf(decoded.toLowerCase()) !== -1
      ) {
        return {
          event: ev,
          matchedLabel: label,
          marketName: ev.name || "Pop-up Market"
        };
      }
    }
    return {
      event: null,
      matchedLabel: decoded,
      marketName: decoded
    };
  }

  function handlePickupMarketDeepLink() {
    if (typeof window === "undefined" || !window.location || !window.location.search) return;
    var params = new URLSearchParams(window.location.search);
    var pickupParam = params.get("pickup_market") || params.get("pickup");
    if (!pickupParam) return;

    var events = window.YL_EVENTS || { upcoming: [], past: [] };
    var result = parsePickupMarketParam(pickupParam, events);
    if (!result) return;

    var pickupSelect = document.getElementById("yl-cart-pickup-select");
    var pickupCheckbox = document.getElementById("yl-cart-pickup-checkbox");
    var pickupContainer = document.getElementById("yl-cart-pickup-select-container");

    if (pickupCheckbox) {
      pickupCheckbox.checked = true;
      pickupCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (pickupSelect && result.matchedLabel) {
      for (var i = 0; i < pickupSelect.options.length; i++) {
        if (
          pickupSelect.options[i].value === result.matchedLabel ||
          pickupSelect.options[i].text.toLowerCase().indexOf(result.marketName.toLowerCase()) !== -1
        ) {
          pickupSelect.selectedIndex = i;
          pickupSelect.dispatchEvent(new Event("change", { bubbles: true }));
          break;
        }
      }
    }
    if (pickupContainer) {
      pickupContainer.style.display = "block";
    }

    // Catalog scroll & announcement on shop page
    var catalogEl = document.getElementById("shop-catalog") || document.getElementById("shopGrid");
    if (catalogEl) {
      try {
        catalogEl.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (err) {
        // fallback if smooth scroll unavailable
      }

      var bannerId = "pickupMarketBanner";
      if (!document.getElementById(bannerId)) {
        var notice = document.createElement("div");
        notice.id = bannerId;
        notice.className = "pickup-market-notice reveal";
        notice.setAttribute("role", "status");
        notice.setAttribute("aria-live", "polite");
        notice.innerHTML =
          '<div class="container">' +
          '<div class="pickup-notice-inner">' +
          '<span><svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px; margin-right:6px;"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg><strong>Pre-order booth pickup activated:</strong> ' +
          attrEsc(result.marketName) +
          " (Free Local Pickup pre-selected)</span>" +
          '<button type="button" class="btn btn-outline btn-sm" id="dismissPickupNotice" aria-label="Dismiss pickup notice">✕</button>' +
          "</div>" +
          "</div>";
        if (catalogEl.parentNode) {
          catalogEl.parentNode.insertBefore(notice, catalogEl);
          var dismissBtn = notice.querySelector("#dismissPickupNotice");
          if (dismissBtn) {
            dismissBtn.addEventListener("click", function () {
              notice.remove();
            });
          }
          wireReveal(notice);
        }
      }
    }
  }

  function eventCardHTML(ev) {
    var gCalUrl = generateGoogleCalendarUrl(ev);
    var icsUri = generateIcsDataUri(ev);
    var icsFilename = getEventIcsFilename(ev);
    var gMapsUrl = generateGoogleMapsDirUrl(ev);
    var appleMapsUrl = generateAppleMapsDirUrl(ev);
    var pickupParam = encodeURIComponent(ev.id || ev.name || "Pop-up Market");

    return (
      '<article class="card event-card reveal">' +
      '<div class="card-body">' +
      '<span class="card-cat">' +
      attrEsc(ev.type || "Pop-Up Market") +
      "</span>" +
      "<h3>" +
      attrEsc(ev.name) +
      "</h3>" +
      '<p class="event-date"><time datetime="' +
      (attrEsc(ev.date) || "") +
      '">' +
      '<svg class="yl-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg> ' +
      attrEsc(ev.dateLabel) +
      "</time></p>" +
      '<p class="event-location">' +
      (ev.location
        ? '<svg class="yl-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg> ' +
          "<span>" +
          attrEsc(ev.location) +
          "</span>" +
          '<span class="event-directions-links"> · <a class="event-map-link" href="' +
          attrEsc(gMapsUrl) +
          '" target="_blank" rel="noopener">Google Maps<span class="sr-only"> directions (opens in new tab)</span></a> · <a class="event-map-link" href="' +
          attrEsc(appleMapsUrl) +
          '" target="_blank" rel="noopener">Apple Maps<span class="sr-only"> directions (opens in new tab)</span></a></span>'
        : "") +
      "</p>" +
      (ev.note ? '<p class="event-desc">' + attrEsc(ev.note) + "</p>" : "") +
      '<div class="event-actions-row" style="display:flex; flex-direction:column; gap:6px; margin-top:12px;">' +
      (safeUrl(ev.url)
        ? '<a class="btn btn-primary btn-sm btn-block" href="' +
          attrEsc(safeUrl(ev.url)) +
          '" target="_blank" rel="noopener">More Info / RSVP<span class="sr-only"> (opens in new tab)</span></a>'
        : "") +
      '<a class="btn btn-outline btn-sm btn-block" href="shop.html?pickup_market=' +
      pickupParam +
      '#shop-catalog">' +
      '<svg class="yl-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg> Reserve / Pick Up at This Booth' +
      "</a>" +
      '<a class="btn btn-outline btn-sm btn-block" href="' +
      attrEsc(gCalUrl) +
      '" target="_blank" rel="noopener">' +
      '<svg class="yl-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg> Add to Google Calendar<span class="sr-only"> (opens in new tab)</span>' +
      "</a>" +
      '<a class="btn btn-outline btn-sm btn-block" href="' +
      attrEsc(icsUri) +
      '" download="' +
      attrEsc(icsFilename) +
      '">' +
      '<svg class="yl-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> iCal / Apple Calendar (.ics)' +
      "</a>" +
      "</div>" +
      "</div>" +
      "</article>"
    );
  }

  function markReveal(container) {
    wireReveal(container);
  }

  function buildFilters(row, categories, grid, allProducts, sortSelect, countEl, searchInput) {
    var concerns = (window.YL_PRODUCTS && window.YL_PRODUCTS.concerns) || [];
    var concernRow = document.getElementById("concernFilterRow");

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

    if (concernRow && concerns.length) {
      var concernPills = [
        '<button class="concern-pill active" type="button" data-concern="all" aria-pressed="true">All Concerns</button>'
      ].concat(
        concerns.map(function (c) {
          return (
            '<button class="concern-pill" type="button" data-concern="' +
            attrEsc(c.id) +
            '" aria-pressed="false">' +
            (c.icon
              ? '<span class="concern-icon" aria-hidden="true">' + attrEsc(c.icon) + "</span> "
              : "") +
            attrEsc(c.name) +
            "</button>"
          );
        })
      );
      concernRow.innerHTML = concernPills.join("");
    }

    var catLabel = {};
    categories.forEach(function (c) {
      catLabel[c.id] = c.label;
    });
    var concernLabel = {};
    concerns.forEach(function (c) {
      concernLabel[c.id] = c.name;
    });

    var state = {
      filter: "all",
      concern: "all",
      sort: sortSelect ? sortSelect.value : "featured",
      query: "",
      scent: "all"
    };

    /* ---------- Scent filter ----------
       Driven entirely by the optional `scent` field on each product (editable
       per product in the CMS). Nothing is hardcoded: the options are the set
       of scents actually in use. Hidden unless the shop owner has switched it
       on AND at least two distinct scents exist -- a filter offering a single
       choice, or none, is just noise.
       Rendered as a compact <select> next to Sort rather than its own row of
       pills -- with search, category pills, and sort already stacked above
       the grid, a whole extra pill row for one secondary facet read as
       clutter. A select keeps the same functionality in a single control. */
    var scentWrap = document.getElementById("scentFieldWrap");
    var scentSelect = document.getElementById("scentSelect");
    if (scentWrap && scentSelect) {
      var siteCfg = (window.YL_CONTENT && window.YL_CONTENT.site) || {};
      // Collect distinct scents with a Set (O(1) membership) instead of
      // Array.indexOf on every product (which made this O(n^2)).
      var seenScents = new Set();
      allProducts.forEach(function (p) {
        var s = (p.scent || "").trim();
        if (s) seenScents.add(s);
      });
      var scents = Array.from(seenScents);
      scents.sort(function (a, b) {
        // "Unscented" is a fallback rather than a scent -- keep it last.
        if (a === "Unscented") return 1;
        if (b === "Unscented") return -1;
        return a.localeCompare(b);
      });

      if (siteCfg.enableScentFilter === false || scents.length < 2) {
        scentWrap.hidden = true;
        scentSelect.innerHTML = '<option value="all">Any</option>';
      } else {
        scentWrap.hidden = false;
        scentSelect.innerHTML =
          '<option value="all">Any</option>' +
          scents
            .map(function (s) {
              return '<option value="' + attrEsc(s) + '">' + attrEsc(s) + "</option>";
            })
            .join("");

        scentSelect.addEventListener("change", function () {
          state.scent = scentSelect.value;
          render();
        });
      }
    }
    // Only the very first render of this grid can plausibly be showing
    // cards that are actually above the fold on initial page load -- every
    // render after that was triggered by a deliberate filter/sort click,
    // well after LCP, so it should always load lazily.
    var isFirstRender = true;

    // 2-Tier FLIR-Style Semantic & Intent Search Ontology
    var STOPWORDS = new Set([
      "a",
      "an",
      "and",
      "are",
      "as",
      "at",
      "be",
      "by",
      "for",
      "from",
      "has",
      "he",
      "in",
      "is",
      "it",
      "its",
      "of",
      "on",
      "that",
      "the",
      "to",
      "was",
      "were",
      "will",
      "with",
      "i",
      "me",
      "my",
      "we",
      "our",
      "you",
      "your",
      "them",
      "some",
      "any",
      "can",
      "do",
      "does",
      "give",
      "help",
      "need",
      "looking",
      "want",
      "find",
      "good",
      "best",
      "something"
    ]);

    var SYNONYM_GROUPS = [
      ["lavender", "lavandula", "lavendula", "lavendar"],
      ["frankincense", "boswellia", "olibanum"],
      ["arnica", "arnica montana"],
      ["calendula", "marigold"],
      ["shea", "shea butter", "butyrospermum parkii", "butyrospermum"],
      ["cedarwood", "cedar"],
      ["eucalyptus", "blue gum"],
      ["peppermint", "mentha piperita", "mint"],
      ["chamomile", "matricaria"],
      ["sleep", "insomnia", "bedtime", "nighttime", "slumber", "restless", "unwind"],
      [
        "sore",
        "ache",
        "aching",
        "pain",
        "muscles",
        "muscle",
        "joint",
        "joints",
        "stiff",
        "stiffness",
        "sprain",
        "bruise",
        "tension",
        "arthritis"
      ],
      ["dry", "chapped", "cracked", "flaky", "ashy", "rough", "eczema", "hydration", "moisturizer"],
      [
        "bug",
        "bugs",
        "mosquito",
        "mosquitoes",
        "tick",
        "ticks",
        "gnat",
        "gnats",
        "insects",
        "insect",
        "repellent",
        "bites"
      ],
      ["smudge", "cleansing", "energy", "smoke-free", "aura", "protection", "banishing"],
      ["shimmer", "glow", "glitter", "sparkle", "radiance", "highlight", "highlighter"],
      ["beard", "mustache", "stubble", "facial hair", "grooming"],
      ["bath", "soak", "soaking", "tub", "epsom", "salts"],
      ["gift", "voucher", "present", "gift card", "certificate", "birthday"]
    ];

    var CATEGORY_TERMS = {
      sleep: ["sleep-salve", "lavender-soak", "bath-tea"],
      insomnia: ["sleep-salve", "lavender-soak", "bath-tea"],
      bedtime: ["sleep-salve", "lavender-soak", "bath-tea"],
      pain: ["miracle-balm", "backroad-soak", "frankincense-salve"],
      "sore muscles": ["miracle-balm", "backroad-soak", "frankincense-salve"],
      muscle: ["miracle-balm", "backroad-soak", "frankincense-salve"],
      joint: ["miracle-balm", "backroad-soak", "frankincense-salve"],
      arthritis: ["miracle-balm", "backroad-soak", "frankincense-salve"],
      "dry skin": [
        "shea-butter",
        "whipped-body-butter",
        "hand-scrub",
        "sugar-scrub",
        "frankincense-salve"
      ],
      eczema: [
        "shea-butter",
        "whipped-body-butter",
        "hand-scrub",
        "sugar-scrub",
        "frankincense-salve"
      ],
      chapped: [
        "shea-butter",
        "whipped-body-butter",
        "hand-scrub",
        "sugar-scrub",
        "frankincense-salve"
      ],
      bug: ["bug-spray", "miracle-balm"],
      mosquito: ["bug-spray", "miracle-balm"],
      insect: ["bug-spray", "miracle-balm"],
      repellent: ["bug-spray", "miracle-balm"],
      smudge: ["cleansing-spray", "porch-sweep-spray", "protection-keychain"],
      energy: ["cleansing-spray", "porch-sweep-spray", "protection-keychain"],
      clearing: ["cleansing-spray", "porch-sweep-spray", "protection-keychain"],
      beard: ["beard-salve"],
      grooming: ["beard-salve"],
      shimmer: ["shimmer-oil"],
      glow: ["shimmer-oil"],
      gift: ["yallternative-gift-card", "custom-box"],
      voucher: ["yallternative-gift-card"],
      shirt: ["unisex-tshirt", "tank-top"],
      tshirt: ["unisex-tshirt", "tank-top"],
      tank: ["tank-top"]
    };

    var SYNONYM_MAP = new Map();
    SYNONYM_GROUPS.forEach(function (group) {
      group.forEach(function (term) {
        var termNorm = term.toLowerCase().trim();
        if (!SYNONYM_MAP.has(termNorm)) {
          SYNONYM_MAP.set(termNorm, new Set());
        }
        group.forEach(function (sibling) {
          if (sibling !== term) {
            SYNONYM_MAP.get(termNorm).add(sibling.toLowerCase().trim());
          }
        });
      });
    });

    function expandQuery(rawQuery) {
      var q = (rawQuery || "").toLowerCase().trim();
      if (!q)
        return { exact: "", tokens: [], expandedTokens: new Set(), hypernymTargets: new Set() };

      var tokens = q
        .replace(/[^\w\s-]/g, " ")
        .split(/\s+/)
        .filter(function (w) {
          return w.length > 1 && !STOPWORDS.has(w);
        });
      var expandedTokens = new Set(tokens);
      var hypernymTargets = new Set();

      tokens.forEach(function (t) {
        if (SYNONYM_MAP.has(t)) {
          SYNONYM_MAP.get(t).forEach(function (syn) {
            syn.split(/\s+/).forEach(function (st) {
              expandedTokens.add(st);
            });
          });
        }
      });

      Object.keys(CATEGORY_TERMS).forEach(function (cat) {
        if (q.indexOf(cat) !== -1 || tokens.includes(cat)) {
          CATEGORY_TERMS[cat].forEach(function (targetId) {
            hypernymTargets.add(targetId);
          });
        }
      });

      return {
        exact: q,
        tokens: tokens,
        expandedTokens: expandedTokens,
        hypernymTargets: hypernymTargets
      };
    }

    function matchesQuery(p, qContext) {
      if (!qContext || !qContext.exact) return { matched: true, score: 1.0 };
      var q = qContext.exact;
      var concernNames = Array.isArray(p.concerns)
        ? p.concerns
            .map(function (cid) {
              return concernLabel[cid] || cid;
            })
            .join(" ")
        : "";
      var keywordList = Array.isArray(p.keywords) ? p.keywords.join(" ") : "";
      var ingredientList = Array.isArray(p.ingredients) ? p.ingredients.join(" ") : "";
      var haystack = (
        p.name +
        " " +
        p.blurb +
        " " +
        (catLabel[p.category] || p.category) +
        " " +
        (p.scent || "") +
        " " +
        concernNames +
        " " +
        keywordList +
        " " +
        ingredientList
      ).toLowerCase();

      var score = 0;
      var isExact = false;

      // 1. Exact Substring Match Guarantee (Floored >= 2.0, Ranked Top)
      if (haystack.indexOf(q) !== -1) {
        isExact = true;
        score += 2.0;
        if (p.name && p.name.toLowerCase().indexOf(q) !== -1) score += 3.0;
      }

      // 2. Tier 2 Hypernym Target
      if (qContext.hypernymTargets.has(p.id)) {
        score += 1.8;
      }

      // 3. Token & Synonym Coverage
      var matchedTokens = 0;
      qContext.expandedTokens.forEach(function (tok) {
        if (haystack.indexOf(tok) !== -1) {
          matchedTokens++;
          score += 0.5;
          if (p.name && p.name.toLowerCase().indexOf(tok) !== -1) score += 1.0;
          if (keywordList.indexOf(tok) !== -1) score += 0.8;
        }
      });

      var passed = isExact || qContext.hypernymTargets.has(p.id) || matchedTokens > 0;
      return {
        matched: passed && score > 0,
        score: score,
        isExact: isExact
      };
    }

    function render() {
      var pMap = getProductMap();
      var q = state.query.trim().toLowerCase();
      var qCtx = expandQuery(state.query);
      var bundlesSection = document.querySelector(".bundles-section");

      if (state.filter === "gift-sets") {
        var filteredBundles = (window.YL_PRODUCTS.bundles || []).filter(function (b) {
          if (state.concern !== "all") {
            if (!Array.isArray(b.concerns) || !b.concerns.includes(state.concern)) return false;
          }
          if (!q) return true;
          var haystack = (
            b.name +
            " " +
            b.blurb +
            " " +
            b.productIds
              .map(function (id) {
                var p = pMap.get(id);
                return p ? p.name : "";
              })
              .join(" ")
          ).toLowerCase();
          if (haystack.indexOf(q) !== -1) return true;
          var hasToken = false;
          qCtx.expandedTokens.forEach(function (tok) {
            if (haystack.indexOf(tok) !== -1) hasToken = true;
          });
          return hasToken;
        });

        grid.innerHTML = bundlesHTML(filteredBundles, pMap);
        wireReveal(grid);

        if (bundlesSection) bundlesSection.style.display = "none";

        if (countEl) {
          if (!filteredBundles.length) {
            countEl.textContent =
              "No gift sets match" +
              (q ? ' "' + state.query.trim() + '"' : " that search") +
              " -- try a different filter or clear the search.";
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

        if (state.concern && state.concern !== "all") {
          filtered = filtered.filter(function (p) {
            return Array.isArray(p.concerns) && p.concerns.includes(state.concern);
          });
        }

        if (state.scent && state.scent !== "all") {
          filtered = filtered.filter(function (p) {
            return (p.scent || "") === state.scent;
          });
        }

        var scoredList = [];
        filtered.forEach(function (p) {
          var res = matchesQuery(p, qCtx);
          if (res.matched) {
            scoredList.push({ product: p, score: res.score });
          }
        });

        var sortedProducts;
        if (q && (!state.sort || state.sort === "featured" || state.sort === "default")) {
          scoredList.sort(function (a, b) {
            return b.score - a.score;
          });
          sortedProducts = scoredList.map(function (item) {
            return item.product;
          });
        } else {
          var matchedProds = scoredList.map(function (item) {
            return item.product;
          });
          sortedProducts = sortProducts(matchedProds, state.sort);
        }

        renderCards(grid, sortedProducts, { eagerFirst: isFirstRender });
        isFirstRender = false;

        if (state.filter === "all") {
          renderBundles(window.YL_PRODUCTS, q, state.concern);
        } else {
          if (bundlesSection) bundlesSection.style.display = "none";
        }

        if (countEl) {
          if (!sortedProducts.length) {
            countEl.textContent =
              "No goods match" +
              (q ? ' "' + state.query.trim() + '"' : " that criteria") +
              " -- try resetting your filters.";
          } else {
            var label = state.filter === "all" ? "goods" : catLabel[state.filter] || "goods";
            var concernNote =
              state.concern !== "all"
                ? " for " + (concernLabel[state.concern] || state.concern).toLowerCase()
                : "";
            countEl.textContent =
              "Showing " +
              sortedProducts.length +
              " of " +
              allProducts.length +
              " " +
              label.toLowerCase() +
              concernNote;
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

    if (concernRow) {
      concernRow.addEventListener("click", function (e) {
        var btn = e.target.closest(".concern-pill");
        if (!btn) return;
        concernRow.querySelectorAll(".concern-pill").forEach(function (b) {
          var isActive = b === btn;
          b.classList.toggle("active", isActive);
          b.setAttribute("aria-pressed", isActive ? "true" : "false");
        });
        state.concern = btn.getAttribute("data-concern");
        render();
      });
    }

    function handleResetFilters() {
      state.filter = "all";
      state.concern = "all";
      state.scent = "all";
      state.query = "";
      if (searchInput) searchInput.value = "";
      var shopSearchEl =
        document.getElementById("shopSearchInput") || document.getElementById("shopSearch");
      if (shopSearchEl) shopSearchEl.value = "";
      if (scentSelect) scentSelect.value = "all";
      var scentSelectEl = document.getElementById("scentSelect");
      if (scentSelectEl) scentSelectEl.value = "all";
      row.querySelectorAll(".filter-pill").forEach(function (b) {
        var isActive = b.getAttribute("data-filter") === "all";
        b.classList.toggle("active", isActive);
        b.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
      if (concernRow) {
        concernRow.querySelectorAll(".concern-pill").forEach(function (b) {
          var isActive = b.getAttribute("data-concern") === "all";
          b.classList.toggle("active", isActive);
          b.setAttribute("aria-pressed", isActive ? "true" : "false");
        });
      }
      render();
    }

    if (grid) {
      grid.addEventListener("click", function (e) {
        var btn = e.target.closest("#resetFiltersBtn");
        if (btn) {
          handleResetFilters();
        }
      });
    }

    var resetBtn = document.getElementById("resetFiltersBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", handleResetFilters);
    }

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

    // Deep-linking: URL search params (?concern=... / ?category=...) and hash #apparel
    try {
      var searchParams = new URLSearchParams(window.location.search);
      var urlConcern = searchParams.get("concern");
      if (
        urlConcern &&
        concerns.some(function (c) {
          return c.id === urlConcern;
        })
      ) {
        state.concern = urlConcern;
        if (concernRow) {
          concernRow.querySelectorAll(".concern-pill").forEach(function (b) {
            var isActive = b.getAttribute("data-concern") === urlConcern;
            b.classList.toggle("active", isActive);
            b.setAttribute("aria-pressed", isActive ? "true" : "false");
          });
        }
      }

      var urlCat = searchParams.get("category") || searchParams.get("filter");
      if (
        urlCat &&
        categories.some(function (c) {
          return c.id === urlCat;
        })
      ) {
        state.filter = urlCat;
        row.querySelectorAll(".filter-pill").forEach(function (b) {
          var isActive = b.getAttribute("data-filter") === urlCat;
          b.classList.toggle("active", isActive);
          b.setAttribute("aria-pressed", isActive ? "true" : "false");
        });
      }
    } catch {
      /* Ignore search param parsing failure */
    }

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

  /* A Snipcart-specific "checkout script failed to load" fallback used to
     live here (watching for window.Snipcart, showing an Etsy-link bar if
     it never appeared). Removed as part of the Stripe migration: cart.js
     is a same-origin, first-party script bundled with the rest of the
     site rather than a lazy-loaded third-party CDN script, so that
     specific failure mode no longer applies. Checkout-request failures
     (e.g. the /api/checkout Worker being unreachable) are instead handled
     inline by cart.js's own checkout() -- see its catch block. */

  /* ---------- Announcement bar: free shipping threshold ---------- */
  (function announcementBar() {
    var data = window.YL_PRODUCTS;
    if (!data || !data.shop) return;
    var threshold = data.shop.freeShippingThreshold;
    if (!threshold || threshold <= 0) return;
    var message = "✦ Free shipping on orders over $" + threshold + " ✦";

    /* index.html already ships a sticky announcement bar (the #yl-countdown-
       ticker pop-up countdown). Blindly prepending a second one stacked two
       full-width sticky bars in the same colour on top of each other -- ~76px
       of near-duplicate chrome pushing the hero down, on the one page where
       the first impression matters most. When that bar is present, fold this
       message into it as a second segment instead of creating a rival bar. */
    var existing = document.getElementById("yl-countdown-ticker");
    if (existing) {
      /* Purely decorative divider -- the visible rule is drawn by the CSS
         background, so this carries no text at all. (It used to hold a "·"
         zeroed out via font-size, which still counted as a text node to
         anything walking the DOM.) */
      var sep = document.createElement("span");
      sep.className = "announcement-sep";
      sep.setAttribute("aria-hidden", "true");
      var seg = document.createElement("span");
      seg.className = "announcement-segment";
      seg.textContent = message;
      existing.appendChild(sep);
      existing.appendChild(seg);
      return;
    }

    var bar = document.createElement("div");
    bar.className = "announcement-bar";
    bar.setAttribute("role", "status");
    bar.textContent = message;
    document.body.insertBefore(bar, document.body.firstChild);
  })();

  /* A Snipcart-specific cart-drawer enhancement (injecting a shipping-
     progress bar and a cross-sell suggestion into Snipcart's own DOM via
     a MutationObserver on window.Snipcart.store) used to live here.
     Removed as part of the Stripe migration: assets/js/cart.js now owns
     the entire drawer and implements both of these natively (see its
     buildProgressHTML-equivalent shipping meter and upsellHTML()), so
     there's no external cart DOM left to observe or inject into. */
  if ("serviceWorker" in navigator) {
    // Show a non-disruptive toast when a new SW version is ready,
    // instead of force-reloading mid-session (which can clear form
    // state and break the visitor's flow).
    //
    // controllerchange also fires on a *first* install: sw.js calls
    // skipWaiting() then clients.claim(), which takes control of the page
    // that just registered it, moving navigator.serviceWorker.controller
    // from null to the new worker. Without this guard every brand-new
    // visitor (and anyone who cleared site data) was told "A new version is
    // available!" seconds after landing, on the version they had just
    // loaded. Only a change away from an existing controller is an update.
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) {
        hadController = true;
        return;
      }
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
    var matchedItem = getProductMap().get(possibleProdId);
    if (matchedItem) {
      setTimeout(function () {
        if (typeof window.openLightbox === "function") {
          // Same shape as the gallery: p.image is the primary, p.images are
          // the extra photos only -- concat so the deep-linked lightbox
          // opens on the primary instead of falling back to slide 0.
          window.openLightbox(
            [matchedItem.image].concat(matchedItem.images || []).filter(Boolean),
            matchedItem.image
          );
        }
      }, 400);
    }
  }

  // 2. Render Social Feed (UGC Community Gallery) if enabled
  var socialFeedGrid = document.getElementById("socialFeedGrid");
  var homeSocialFeedSection = document.getElementById("homeSocialFeed");
  var shopSocialFeedGrid = document.getElementById("shopSocialFeedGrid");
  var shopSocialFeedSection = document.getElementById("shopSocialFeed");
  var enableSocialFeed =
    window.YL_CONTENT &&
    window.YL_CONTENT.site &&
    window.YL_CONTENT.site.enableSocialFeed !== undefined
      ? window.YL_CONTENT.site.enableSocialFeed
      : /*YL:site.enableSocialFeed*/ true; /*/YL:site.enableSocialFeed*/
  /* Read the live flag the same way enableSocialFeed above does. The
     build injects the `YL:site` markers into HTML pages only -- never into
     this file -- so the baked-in literal is a stale second source of truth
     that content.json cannot correct. Flipping enableJournal in /admin
     updated the nav link, the sitemap and robots tag while this constant
     stayed put, leaving the Journal half-on. YL_CONTENT is generated from
     content.json, so it is the authority; the literal is only the fallback
     for a page that loads without content-data.js. */
  var enableJournal =
    window.YL_CONTENT &&
    window.YL_CONTENT.site &&
    window.YL_CONTENT.site.enableJournal !== undefined
      ? window.YL_CONTENT.site.enableJournal
      : /*YL:site.enableJournal*/ false; /*/YL:site.enableJournal*/

  function renderUgcFeed(gridElem, sectionElem) {
    if (!enableSocialFeed || !gridElem || !sectionElem || !window.YL_SOCIAL_FEED) return;
    var socialPosts = window.YL_SOCIAL_FEED.posts || [];
    if (socialPosts.length === 0) return;

    sectionElem.style.display = "block";
    gridElem.innerHTML = socialPosts
      .map(function (post) {
        var altText = post.caption
          ? "Customer community photo: " + post.caption.slice(0, 80)
          : "Y'allternative Living customer post";
        var productTagHtml = "";
        if (post.productId && post.productName) {
          productTagHtml =
            '<a href="shop.html#' +
            attrEsc(post.productId) +
            '" class="ugc-product-tag" aria-label="View ' +
            attrEsc(post.productName) +
            ' in shop">' +
            '  <svg class="yl-icon" aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg> ' +
            attrEsc(post.productName) +
            "</a>";
        }
        var postLink = safeUrl(post.url);
        var linkHtml = postLink
          ? '<a href="' +
            attrEsc(postLink) +
            '" target="_blank" rel="noopener" class="ugc-post-link" aria-label="View original post by ' +
            attrEsc(post.handle || "@yallternativeliving") +
            ' (opens in new tab)">View Post &#8599;<span class="sr-only"> (opens in new tab)</span></a>'
          : "";

        return (
          /* A <div>, not an <article>: role="listitem" is not a valid role
             override for <article>, so each card announced itself as a
             stray article instead of as item N of the surrounding
             role="list" feed (axe aria-allowed-role). */
          '<div class="ugc-card reveal" role="listitem">' +
          '  <div class="ugc-card-media">' +
          '    <img src="' +
          attrEsc(post.image) +
          '" alt="' +
          attrEsc(altText) +
          '" loading="lazy" decoding="async" width="400" height="400">' +
          '    <div class="ugc-media-badge">' +
          '      <svg class="yl-icon" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1"/></svg>' +
          "      <span>UGC</span>" +
          "    </div>" +
          productTagHtml +
          "  </div>" +
          '  <div class="ugc-card-body">' +
          '    <div class="ugc-author-row">' +
          '      <span class="ugc-author-name">' +
          attrEsc(post.author || "Community Member") +
          "</span>" +
          '      <span class="ugc-author-handle">' +
          attrEsc(post.handle || "@yallternativeliving") +
          "</span>" +
          "    </div>" +
          '    <p class="ugc-caption">' +
          attrEsc(post.caption) +
          "</p>" +
          linkHtml +
          "  </div>" +
          "</div>"
        );
      })
      .join("");
    wireReveal(gridElem);
  }

  renderUgcFeed(socialFeedGrid, homeSocialFeedSection);
  renderUgcFeed(shopSocialFeedGrid, shopSocialFeedSection);

  /* ---------- Journal Helpers & Component Renderers ---------- */
  function getReadingTime(post) {
    if (!post) return "1 min read";
    if (post.readingTime) return post.readingTime;
    var text = (post.content || "") + " " + (post.excerpt || "");
    var words = text
      .replace(/<[^>]*>/g, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    var mins = Math.max(1, Math.ceil(words / 200));
    return mins + " min read";
  }

  function renderClockIconSvg() {
    return '<svg class="journal-clock-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  }

  function renderJournalTagsHtml(tags) {
    if (!Array.isArray(tags) || !tags.length) return "";
    return (
      '<div class="journal-tags" aria-label="Article topics">' +
      tags
        .map(function (t) {
          return (
            '<button type="button" class="journal-tag journal-tag-pill" data-tag="' +
            attrEsc(t) +
            '">' +
            attrEsc(t) +
            "</button>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function findFeaturedProduct(productId) {
    if (!productId) return null;
    var products = (window.YL_PRODUCTS && window.YL_PRODUCTS.products) || [];
    if (!products.length) return null;

    var direct = products.find(function (p) {
      return p.id === productId;
    });
    if (direct) return direct;

    var aliases = {
      "magnesium-body-butter": "sleep-salve",
      "pine-tar-salve": "frankincense-salve",
      "magnesium-salve": "sleep-salve",
      "lavender-butter": "shea-butter"
    };
    if (aliases[productId]) {
      var mapped = products.find(function (p) {
        return p.id === aliases[productId];
      });
      if (mapped) return mapped;
    }

    return (
      products.find(function (p) {
        return (
          p.id.indexOf(productId) !== -1 ||
          productId.indexOf(p.id) !== -1 ||
          (p.name &&
            p.name.toLowerCase().indexOf(productId.toLowerCase().replace(/-/g, " ")) !== -1)
        );
      }) || null
    );
  }

  function renderFeaturedProductCardHtml(productId) {
    var featProd = findFeaturedProduct(productId);
    if (!featProd) return "";

    var priceFormatted =
      typeof featProd.price === "number"
        ? featProd.price.toFixed(2)
        : String(featProd.price || "0.00");
    var scentBadgeHtml = featProd.scent
      ? '<span class="journal-featured-scent">' + attrEsc(featProd.scent) + "</span>"
      : "";
    var categoryBadgeHtml = featProd.category
      ? '<span class="journal-featured-cat">' + attrEsc(featProd.category) + "</span>"
      : "";

    return (
      '<aside class="journal-featured-card reveal" aria-labelledby="journalFeaturedHeading">' +
      '  <div class="journal-featured-inner">' +
      '    <div class="journal-featured-header">' +
      '      <span class="journal-featured-pill">Featured in this Article</span>' +
      '      <h4 id="journalFeaturedHeading">Small-Batch Botanical Care</h4>' +
      "    </div>" +
      '    <div class="journal-featured-body">' +
      '      <img class="journal-featured-thumb" src="' +
      attrEsc(featProd.image) +
      '" alt="' +
      attrEsc(featProd.name) +
      '" width="100" height="100" loading="lazy">' +
      '      <div class="journal-featured-details">' +
      '        <div class="journal-featured-badges">' +
      categoryBadgeHtml +
      scentBadgeHtml +
      "        </div>" +
      '        <h5 class="journal-featured-title"><a href="shop.html#' +
      attrEsc(featProd.id) +
      '">' +
      attrEsc(featProd.name) +
      "</a></h5>" +
      '        <p class="journal-featured-blurb">' +
      attrEsc(featProd.blurb || featProd.description || "") +
      "</p>" +
      '        <div class="journal-featured-action">' +
      '          <span class="journal-featured-price">$' +
      priceFormatted +
      "</span>" +
      '          <button type="button" class="btn btn-sm btn-primary yl-add-item" ' +
      '            data-item-id="' +
      attrEsc(featProd.id) +
      '" ' +
      '            data-item-name="' +
      attrEsc(featProd.name) +
      '" ' +
      '            data-item-price="' +
      priceFormatted +
      '" ' +
      '            data-item-image="' +
      attrEsc(featProd.image) +
      '" ' +
      '            data-item-categories="' +
      attrEsc(featProd.category || "") +
      '">' +
      '            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg> ' +
      "            + Add to Cart" +
      "          </button>" +
      "        </div>" +
      "      </div>" +
      "    </div>" +
      "  </div>" +
      "</aside>"
    );
  }

  // 3. Render Journal (Blog) Page
  var journalApp = document.getElementById("journalApp");
  if (journalApp && window.YL_JOURNAL) {
    var journalPosts = window.YL_JOURNAL.posts || [];
    var currentJournalTagFilter = null;

    function renderJournalList() {
      /* Switched off, or on with nothing written yet: both get the same
         "coming soon" notice. The page is kept out of the nav, out of
         sitemap.xml and out of llms.txt while the flag is off and carries a
         noindex tag, so the only way to see this is to already know the URL. */
      if (!enableJournal || journalPosts.length === 0) {
        journalApp.innerHTML =
          '<div class="section-head reveal">' +
          "  <h2>Journal Coming Soon</h2>" +
          "  <p>Savanna is stirring up some stories. Check back soon for herbal folklore, batch updates, and behind-the-scenes thoughts.</p>" +
          "</div>";
        wireReveal(journalApp);
        return;
      }

      var filteredPosts = currentJournalTagFilter
        ? journalPosts.filter(function (p) {
            return Array.isArray(p.tags) && p.tags.indexOf(currentJournalTagFilter) !== -1;
          })
        : journalPosts;

      var filterBannerHtml = currentJournalTagFilter
        ? '<div class="journal-filter-banner reveal">' +
          "  <span>Showing articles tagged with: <strong>" +
          attrEsc(currentJournalTagFilter) +
          "</strong></span>" +
          '  <button type="button" class="btn btn-xs btn-outline" id="journalClearFilter">Clear Filter ✕</button>' +
          "</div>"
        : "";

      var listHtml =
        filterBannerHtml +
        '<h2 class="sr-only">Latest Articles</h2>' +
        '<div class="grid grid-3 stagger">' +
        filteredPosts
          .map(function (post) {
            var readTime = getReadingTime(post);
            var tagsHtml = renderJournalTagsHtml(post.tags);
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
              '  <div class="journal-card-meta">' +
              '    <span class="card-cat">Published ' +
              attrEsc(post.date) +
              "</span>" +
              '    <span class="journal-reading-time">' +
              renderClockIconSvg() +
              " " +
              attrEsc(readTime) +
              "</span>" +
              "  </div>" +
              '  <h3><a href="#post-' +
              attrEsc(post.id) +
              '">' +
              attrEsc(post.title) +
              "</a></h3>" +
              tagsHtml +
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

      journalApp.querySelectorAll(".journal-tag").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          var tag = btn.getAttribute("data-tag");
          currentJournalTagFilter = currentJournalTagFilter === tag ? null : tag;
          renderJournalList();
        });
      });

      var clearBtn = document.getElementById("journalClearFilter");
      if (clearBtn) {
        clearBtn.addEventListener("click", function () {
          currentJournalTagFilter = null;
          renderJournalList();
        });
      }

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

      // Markdown-aware and escape-first (see renderMarkdown above). A post
      // written as plain blank-line-separated text -- which is every post
      // published before the CMS grew a formatting toolbar -- still renders
      // as exactly the same <p> blocks it always did.
      var body = renderMarkdown(post.content);
      var readTime = getReadingTime(post);
      var tagsHtml = renderJournalTagsHtml(post.tags);
      var featuredCardHtml = post.featuredProductId
        ? renderFeaturedProductCardHtml(post.featuredProductId)
        : "";

      journalApp.innerHTML =
        '<div class="journal-detail">' +
        '  <div class="back-link reveal" id="journalBackBtn">← Back to Journal</div>' +
        '  <h2 class="reveal">' +
        attrEsc(post.title) +
        "</h2>" +
        '  <div class="meta reveal">' +
        '    <span class="journal-detail-date">Published on ' +
        attrEsc(post.date) +
        "</span>" +
        '    <span class="journal-meta-sep">·</span>' +
        '    <span class="journal-reading-time">' +
        renderClockIconSvg() +
        " " +
        attrEsc(readTime) +
        "</span>" +
        "  </div>" +
        (tagsHtml ? '  <div class="journal-detail-tags reveal">' + tagsHtml + "</div>" : "") +
        (post.image
          ? '  <img class="reveal" src="' +
            attrEsc(post.image) +
            '" alt="' +
            attrEsc(post.title) +
            '">'
          : "") +
        '  <div class="content reveal">' +
        body +
        "</div>" +
        featuredCardHtml +
        "</div>";

      document.getElementById("journalBackBtn").addEventListener("click", function () {
        window.location.hash = "";
      });

      journalApp.querySelectorAll(".journal-tag").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.preventDefault();
          var tag = btn.getAttribute("data-tag");
          currentJournalTagFilter = tag;
          window.location.hash = "";
        });
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

  /* ---------- Speculation Rules (instant navigations) ----------
     Browser-level speculative prerender/prefetch based on user intent.
     Injected from JS (not hard-coded in every page's <head>) so it lives
     in one cached file and applies everywhere automatically.

     Eagerness is "moderate": the browser prerenders a link only after the
     user hovers/focuses it for ~200ms -- a strong signal of intent, which
     keeps wasted speculations low on a small catalog. (The report this was
     drawn from said "conservative" fires on hover; that's wrong --
     "conservative" only fires on pointerdown. "moderate" is the hover one.)

     Feature-detected so nothing breaks on browsers without support, and it
     honors Save-Data / reduced-data users by skipping speculation for them.
     CSP note: inline speculation-rules scripts are allowed via the
     'inline-speculation-rules' source in script-src (see
     scripts/build-security-headers.js) -- they do NOT open up general
     inline script execution. */
  (function () {
    try {
      if (
        typeof HTMLScriptElement === "undefined" ||
        typeof HTMLScriptElement.supports !== "function" ||
        !HTMLScriptElement.supports("speculationrules")
      ) {
        return;
      }
      // Respect users who've asked the browser to conserve data.
      var conn = navigator.connection;
      if (conn && (conn.saveData === true || /(^|-)2g$/.test(conn.effectiveType || ""))) {
        return;
      }
      var rules = {
        prerender: [
          {
            source: "document",
            where: {
              and: [
                { href_matches: "/*" },
                // Don't prerender cart/checkout, external links, or the
                // language-translation proxy -- only informational pages.
                { not: { href_matches: "/*\\?*" } },
                { not: { selector_matches: "[data-item-add-to-cart]" } },
                { not: { selector_matches: ".cart-toggle" } },
                { not: { selector_matches: '[rel~="nofollow"]' } }
              ]
            },
            eagerness: "moderate"
          }
        ],
        prefetch: [
          {
            source: "document",
            where: { href_matches: "/*" },
            eagerness: "moderate"
          }
        ]
      };
      var s = document.createElement("script");
      s.type = "speculationrules";
      s.textContent = JSON.stringify(rules);
      document.body.appendChild(s);
    } catch {
      /* speculation is a progressive enhancement -- never let it break the page */
    }
  })();

  /* ---------- R1: Live Market Event Countdown Ticker ---------- */

  /* Picks the pop-up the hero ticker and the events-page banner should point
     at, given today's date as a YYYY-MM-DD string. Returns
     { event, startTime } or null when there's nothing left on the calendar.
     Split out of initCountdownTicker so it can be unit-tested without a DOM
     (scripts/main.test.js). */
  function pickNextEvent(list, todayStr) {
    var best = null;
    (list || []).forEach(function (evt) {
      if (!evt || !evt.date) return;
      /* Same cutoff the events.html list uses (see the auto-promote block
         above): a multi-day market stays the "next" pop-up through its final
         day, so day two reads as happening now instead of skipping ahead to
         the following event while the list right below it still shows the
         market that's open today. */
      if (String(evt.endDate || evt.date).slice(0, 10) < todayStr) return;
      var t;
      if (evt.date.length === 10) {
        var p = evt.date.split("-");
        t = new Date(p[0], p[1] - 1, p[2], 9, 0, 0).getTime();
      } else {
        t = new Date(evt.date).getTime();
      }
      if (isNaN(t)) return;
      /* Take the SOONEST event, not merely the first one in the array.
         events.json is hand-ordered through the CMS, so an event Savanna
         adds out of sequence would otherwise have the hero counting down to
         a date weeks away while events.html -- which sorts -- names a
         different pop-up as the next one. */
      if (!best || t < best.startTime) best = { event: evt, startTime: t };
    });
    return best;
  }

  function initCountdownTicker() {
    var tickerContainer = document.getElementById("yl-countdown-ticker");
    var bannerContainer = document.getElementById("eventsCountdownBanner");
    if (!tickerContainer && !bannerContainer) return;

    var upcomingList =
      window.YL_EVENTS && window.YL_EVENTS.upcoming ? window.YL_EVENTS.upcoming : [];
    var picked = pickNextEvent(upcomingList, new Date().toISOString().slice(0, 10));
    var nextEvt = picked ? picked.event : null;
    var targetTime = picked ? picked.startTime : 0;

    if (!nextEvt) {
      if (tickerContainer) {
        var timerEl = document.getElementById("heroCountdownTimer");
        if (timerEl) {
          timerEl.textContent =
            "Stay tuned for new confirmed market dates! | Handcrafted in Landrum, SC";
        }
      }
      if (bannerContainer) {
        bannerContainer.innerHTML =
          '<p class="muted center">Check back soon for upcoming market appearances!</p>';
      }
      return;
    }

    var daysSpan = document.getElementById("yl-countdown-days");
    var hoursSpan = document.getElementById("yl-countdown-hours");
    var minsSpan = document.getElementById("yl-countdown-minutes");
    var secsSpan = document.getElementById("yl-countdown-seconds");
    var eventDetailsSpan = document.getElementById("heroEventDetails");

    /* .countdown-card has no rule in styles.css -- the card is drawn entirely
       by these inline styles. The "in progress today" branch below used to
       emit the bare class with nothing on it, so from 9am on a market day the
       banner dropped its panel, border and centering and rendered as raw
       text. Shared here so both states of the same card stay identical. */
    var countdownCardStyle =
      "background: var(--ink-3); color: var(--paper); border: 1px solid var(--hide); border-radius: var(--radius-md); padding: 1.25rem; margin-bottom: 1.5rem; text-align: center;";

    function update() {
      var rem = targetTime - Date.now();
      if (rem <= 0) {
        if (tickerContainer) {
          var timerEl = document.getElementById("heroCountdownTimer");
          if (timerEl) timerEl.textContent = nextEvt.name + " is in progress today!";
          /* The badge next to it is baked into the HTML as "NEXT POP-UP:",
             which reads wrong once the pop-up is the one happening right now.
             Match the events-page banner, which already says "Happening Now". */
          var badgeEl = tickerContainer.querySelector(".ticker-badge");
          if (badgeEl) {
            badgeEl.innerHTML =
              '<svg class="yl-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg> HAPPENING NOW:';
          }
        }
        if (bannerContainer) {
          bannerContainer.innerHTML =
            '<div class="countdown-card" style="' +
            countdownCardStyle +
            '"><span class="card-cat" style="color: var(--whiskey); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700;">Happening Now</span>' +
            '<h3 style="margin: 0.4rem 0 0.6rem; font-family: var(--font-heading);">' +
            attrEsc(nextEvt.name) +
            "</h3>" +
            '<p style="margin: 0;">Pop-up in progress today!</p></div>';
        }
        return;
      }

      var totalSec = Math.floor(rem / 1000);
      var d = Math.floor(totalSec / (3600 * 24));
      totalSec %= 3600 * 24;
      var h = Math.floor(totalSec / 3600);
      totalSec %= 3600;
      var m = Math.floor(totalSec / 60);
      var s = totalSec % 60;

      var hStr = String(h);
      var mStr = String(m);
      var sStr = String(s);

      if (daysSpan) daysSpan.textContent = String(d);
      if (hoursSpan) hoursSpan.textContent = hStr;
      if (minsSpan) minsSpan.textContent = mStr;
      if (secsSpan) secsSpan.textContent = sStr;
      if (eventDetailsSpan)
        eventDetailsSpan.textContent =
          nextEvt.name + (nextEvt.location ? " (" + nextEvt.location + ")" : "");

      if (bannerContainer) {
        var timeStr =
          d +
          (d === 1 ? " Day, " : " Days, ") +
          hStr +
          (h === 1 ? " Hour, " : " Hours, ") +
          mStr +
          " Mins, " +
          sStr +
          " Secs";
        bannerContainer.innerHTML =
          '<div class="countdown-card" style="' +
          countdownCardStyle +
          '">' +
          '  <span class="card-cat" style="color: var(--whiskey); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700;">Next Live Appearance</span>' +
          '  <h3 style="margin: 0.4rem 0 0.6rem; font-family: var(--font-heading);">' +
          attrEsc(nextEvt.name) +
          "</h3>" +
          '  <p class="event-timer-clock" style="font-size: 1.1rem; margin: 0.2rem 0 0.4rem;"><svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 14 14"></polyline></svg> <strong>' +
          timeStr +
          "</strong> until pop-up</p>" +
          '  <p class="event-location" style="font-size: 0.85rem; color: var(--paper-dim); margin: 0;"><svg class="yl-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg> ' +
          attrEsc(nextEvt.location || "Upstate, SC") +
          "</p>" +
          "</div>";
      }
    }

    update();
    setInterval(update, 1000);
  }
  if (siteFlagEnabled("enableCountdownTicker")) initCountdownTicker();

  /* ---------- R2: Order Status Lookup Modal Controller ---------- */
  function initOrderStatusModal() {
    var modal = document.getElementById("order-status-modal");
    if (!modal) return;

    var lastFocusedElement = null;

    function openModal() {
      lastFocusedElement = document.activeElement;
      if (typeof modal.showModal === "function") {
        modal.showModal();
      } else {
        modal.setAttribute("open", "");
      }
      setTimeout(function () {
        var input = document.getElementById("order-id-input");
        if (input) input.focus();
      }, 50);
    }

    function closeModal() {
      if (typeof modal.close === "function") {
        modal.close();
      } else {
        modal.removeAttribute("open");
      }
      if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
        lastFocusedElement.focus();
      }
    }

    document.addEventListener("click", function (e) {
      var trigger = e.target.closest(
        '[data-action="open-order-status"], #openOrderStatusBtn, a[href="#order-status"]'
      );
      if (trigger) {
        e.preventDefault();
        /* The build hides the trigger with CSS when the switch is off, but a
           page built before the switch flipped still ships the button. Refuse
           to open rather than trust the stylesheet. */
        if (siteFlagEnabled("enableOrderStatusLookup")) openModal();
      }
      var closeBtn = e.target.closest(
        '[data-action="close-order-status"], #closeOrderStatusModalBtn'
      );
      if (closeBtn) {
        e.preventDefault();
        closeModal();
      }
    });

    modal.addEventListener("click", function (e) {
      if (e.target === modal) {
        closeModal();
      }
    });

    modal.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal();
        return;
      }
      if (e.key === "Tab") {
        var focusables = modal.querySelectorAll(
          'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables.length) return;
        var first = focusables[0];
        var last = focusables[focusables.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    });

    var form = document.getElementById("orderStatusForm");
    var resultsContainer = document.getElementById("order-timeline-container");
    var errorSpan = document.getElementById("orderLookupError");

    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var input = document.getElementById("order-id-input");
        var val = String((input && input.value) || "").trim();
        if (!val) {
          if (errorSpan) {
            errorSpan.textContent = "Please enter your order reference number.";
            errorSpan.hidden = false;
          }
          return;
        }
        if (errorSpan) errorSpan.hidden = true;

        /* Same honest answer as the dedicated page: no order is fetched
           anywhere, so nothing about one is asserted. See the comment above
           orderStatusFallbackHTML. */
        var parsed = parseOrderStatusQuery(val);
        var display = parsed
          ? parsed.displayId
          : val.length > 28
            ? val.substring(0, 28) + "..."
            : val;

        if (resultsContainer) {
          resultsContainer.innerHTML = orderStatusFallbackHTML(display);
          resultsContainer.hidden = false;
        }
      });
    }
  }
  initOrderStatusModal();

  /* ---------- R4: Apothecary Recommendation Quiz Controller ---------- */
  function initApothecaryQuiz() {
    var quizSection = document.getElementById("apothecary-quiz-section");
    if (!quizSection) return;

    var modal = document.getElementById("apothecary-quiz-modal");
    var openBtn = document.getElementById("open-apothecary-quiz-btn");
    var closeBtn = document.getElementById("close-apothecary-quiz-modal");

    if (openBtn && modal) {
      openBtn.addEventListener("click", function () {
        if (typeof modal.showModal === "function") {
          modal.showModal();
        } else {
          modal.setAttribute("open", "true");
        }
      });
    }
    if (closeBtn && modal) {
      closeBtn.addEventListener("click", function () {
        if (typeof modal.close === "function") {
          modal.close();
        } else {
          modal.removeAttribute("open");
        }
      });
    }
    if (modal) {
      modal.addEventListener("click", function (e) {
        if (e.target === modal) {
          if (typeof modal.close === "function") modal.close();
          else modal.removeAttribute("open");
        }
      });
    }

    var step1 = document.getElementById("quiz-step-1");
    var step2 = document.getElementById("quiz-step-2");
    var step3 = document.getElementById("quiz-step-3");
    var results = document.getElementById("quiz-results-container");
    var resetBtn = document.getElementById("start-apothecary-quiz-btn");
    var submitBtn = document.getElementById("quiz-submit-btn");

    function resetQuiz() {
      if (step1) step1.style.display = "block";
      if (step2) step2.style.display = "none";
      if (step3) step3.style.display = "none";
      if (results) {
        results.style.display = "none";
        results.innerHTML = "";
      }
    }

    if (resetBtn) {
      resetBtn.addEventListener("click", resetQuiz);
    }

    quizSection.addEventListener("click", function (e) {
      var nextBtn = e.target.closest(".quiz-next-step");
      if (nextBtn) {
        var targetStep = nextBtn.getAttribute("data-next");
        if (targetStep === "2") {
          if (step1) step1.style.display = "none";
          if (step2) step2.style.display = "block";
        } else if (targetStep === "3") {
          if (step2) step2.style.display = "none";
          if (step3) step3.style.display = "block";
        }
        return;
      }

      var prevBtn = e.target.closest(".quiz-prev-step");
      if (prevBtn) {
        var prevStep = prevBtn.getAttribute("data-prev");
        if (prevStep === "1") {
          if (step2) step2.style.display = "none";
          if (step1) step1.style.display = "block";
        } else if (prevStep === "2") {
          if (step3) step3.style.display = "none";
          if (step2) step2.style.display = "block";
        }
        return;
      }
    });

    if (submitBtn) {
      submitBtn.addEventListener("click", function () {
        var vibe =
          (quizSection.querySelector('input[name="quiz-vibe"]:checked') || {}).value ||
          "gothic-calm";
        var need =
          (quizSection.querySelector('input[name="quiz-need"]:checked') || {}).value || "hydration";
        var intent =
          (quizSection.querySelector('input[name="quiz-intent"]:checked') || {}).value ||
          "treat-myself";

        var catalog = (window.YL_PRODUCTS && window.YL_PRODUCTS.products) || [];
        var bundles = (window.YL_PRODUCTS && window.YL_PRODUCTS.bundles) || [];
        var allItems = catalog.concat(
          bundles.map(function (b) {
            return Object.assign({}, b, { isBundle: true });
          })
        );

        if (!allItems.length) return;

        var gothicCalmSet = new Set([
          "sleep-salve",
          "lavender-soak",
          "bath-tea",
          "night-ritual-set"
        ]);
        var ritualRestSet = new Set([
          "shea-butter",
          "bath-tea",
          "cleansing-spray",
          "night-ritual-set"
        ]);
        var hexingEnergySet = new Set([
          "protection-keychain",
          "shimmer-oil",
          "porch-sweep-spray",
          "pride-set"
        ]);
        var dailySootheSet = new Set([
          "frankincense-salve",
          "miracle-balm",
          "hand-scrub",
          "bug-spray"
        ]);

        var scored = allItems.map(function (item) {
          var score = 0;

          if (vibe === "gothic-calm" && gothicCalmSet.has(item.id)) score += 5;
          if (vibe === "ritual-rest" && ritualRestSet.has(item.id)) score += 5;
          if (vibe === "hexing-energy" && hexingEnergySet.has(item.id)) score += 5;
          if (vibe === "daily-soothe" && dailySootheSet.has(item.id)) score += 5;

          if (need === "hydration" && (item.category === "salves" || item.category === "body"))
            score += 4;
          if (need === "muscle-soak" && (item.category === "soaks" || item.id === "sleep-salve"))
            score += 4;
          if (need === "herbal-salve" && (item.category === "salves" || item.id === "bug-spray"))
            score += 4;
          if (
            need === "apparel-lifestyle" &&
            (item.category === "apparel" ||
              item.category === "potions" ||
              item.category === "ritual")
          )
            score += 4;

          if (
            intent === "gift-bestie" &&
            (item.isBundle ||
              item.id === "yallternative-gift-card" ||
              item.id === "protection-keychain")
          )
            score += 6;
          if (
            intent === "ritual-bath" &&
            (item.category === "soaks" || item.id === "bath-tea" || item.id === "cleansing-spray")
          )
            score += 5;
          if (intent === "treat-myself" && (item.id === "shimmer-oil" || item.featured)) score += 3;

          if (item.comingSoon || item.stock === 0) score -= 20;

          return { item: item, score: score };
        });

        scored.sort(function (a, b) {
          return b.score - a.score;
        });
        var match = scored[0] ? scored[0].item : allItems[0];

        var rationale =
          "Prescribed based on your choice of " +
          vibe.replace("-", " ") +
          " vibes, " +
          need.replace("-", " ") +
          " focus, and " +
          intent.replace("-", " ") +
          " intent.";
        var pMap = getProductMap();
        var firstBundleProduct =
          match.isBundle && Array.isArray(match.productIds) && pMap.get(match.productIds[0]);
        var itemImage =
          match.image ||
          (match.images && match.images[0]) ||
          (firstBundleProduct && firstBundleProduct.image) ||
          "assets/img/logo.png";

        var getRecPrice = function (item) {
          if (typeof item.price === "number") return item.price;
          if (typeof item.bundlePrice === "number") return item.bundlePrice;
          if (typeof item.regularPrice === "number") return item.regularPrice;
          if (Array.isArray(item.productIds)) {
            var fullPrice = item.productIds.reduce(function (sum, id) {
              var p = pMap.get(id);
              return sum + (p ? p.originalPrice || p.price || 0 : 0);
            }, 0);
            return Math.round(fullPrice * (1 - (item.discountPercent || 0) / 100) * 100) / 100;
          }
          return 0;
        };

        var recPrice = getRecPrice(match);
        if (typeof recPrice !== "number" || isNaN(recPrice)) {
          recPrice = 0;
        }

        var loyalty = getLoyaltyConfig();
        var quizPointsBadgeHTML = loyalty.enabled
          ? '  <div style="text-align: center; margin-bottom: 12px;"><span class="alt-points-badge">' +
            attrEsc(loyalty.emoji) +
            ' Earn <span class="pts-val">' +
            Math.floor(recPrice * loyalty.rate) +
            "</span> " +
            attrEsc(loyalty.name) +
            "</span></div>"
          : "";

        if (results) {
          results.innerHTML =
            '<div class="card quiz-recommended-card reveal" style="max-width: 540px; margin: 0 auto; padding: 1.5rem; text-align: center; border: 2px solid var(--whiskey); background: var(--ink-3); color: var(--paper); border-radius: var(--radius-md);">' +
            '  <span class="card-cat" style="color: var(--whiskey); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700;"><svg class="yl-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"></path></svg> Your Apothecary Prescription</span>' +
            '  <h3 style="font-family: var(--font-heading); margin: 0.5rem 0;">' +
            attrEsc(match.name) +
            "</h3>" +
            '  <img src="' +
            attrEsc(itemImage) +
            '" alt="' +
            attrEsc(match.name) +
            '" style="width: 140px; height: 140px; object-fit: cover; border-radius: var(--radius-sm); margin: 0.5rem auto 1rem; display: block;">' +
            '  <p style="font-size: 0.9rem; margin-bottom: 0.75rem;">' +
            attrEsc(match.blurb || "") +
            "</p>" +
            '  <p style="font-size: 0.82rem; color: var(--whiskey); font-style: italic; margin-bottom: 0.75rem;">' +
            attrEsc(rationale) +
            "</p>" +
            quizPointsBadgeHTML +
            '  <button type="button" class="btn btn-primary btn-block yl-add-item"' +
            '    data-item-id="' +
            attrEsc(match.isBundle ? "bundle-" + match.id : match.id) +
            '"' +
            '    data-item-name="' +
            attrEsc(match.name) +
            '"' +
            '    data-item-price="' +
            recPrice.toFixed(2) +
            '"' +
            '    data-item-image="' +
            attrEsc(itemImage) +
            '"' +
            '    data-item-description="' +
            attrEsc(match.blurb || "") +
            '">' +
            "    Add Recommendation to Cart ($" +
            recPrice.toFixed(2) +
            ")" +
            "  </button>" +
            '  <button type="button" class="btn btn-link btn-sm" id="quizRetakeBtn" style="margin-top: 1rem; color: var(--paper-muted);">Take Quiz Again</button>' +
            "</div>";

          if (step3) step3.style.display = "none";
          results.style.display = "block";

          // The recommendation card ships with the `reveal` class (opacity:0
          // until observed). Every other dynamically-injected section wires up
          // its reveal animation after inserting markup; this one never did, so
          // the finished card rendered fully transparent -- the quiz looked
          // like it did nothing. Wire it up so the card actually fades in.
          wireReveal(results);

          var retakeBtn = document.getElementById("quizRetakeBtn");
          if (retakeBtn) retakeBtn.addEventListener("click", resetQuiz);
        }
      });
    }
  }
  if (siteFlagEnabled("enableApothecaryQuiz")) initApothecaryQuiz();
  /* ==================== GLOBAL SEARCH SUITE (2026 SOTA) ==================== */
  var searchIndexCache = null;

  function escapeSearchHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getSearchIndex() {
    if (searchIndexCache) return searchIndexCache;
    if (typeof window !== "undefined" && window.YL_SEARCH_INDEX) {
      searchIndexCache = window.YL_SEARCH_INDEX;
      return searchIndexCache;
    }
    var prods = (typeof window !== "undefined" && window.PRODUCTS) || [];
    var jrnl =
      typeof window !== "undefined" && window.JOURNAL
        ? window.JOURNAL.articles || window.JOURNAL
        : [];
    var evts =
      typeof window !== "undefined" && window.EVENTS
        ? (window.EVENTS.upcoming || []).concat(window.EVENTS.past || [])
        : [];
    var fqs = (typeof window !== "undefined" && window.FAQ) || [];
    return {
      version: "fallback",
      products: prods,
      journal: jrnl,
      events: evts,
      faq: fqs,
      synonyms: {}
    };
  }

  function tokenizeQuery(rawQuery) {
    if (!rawQuery || typeof rawQuery !== "string") return [];
    var cleaned = rawQuery
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .trim();
    if (!cleaned) return [];
    var rawTokens = cleaned.split(/\s+/).filter(Boolean);
    var seen = new Set();
    var result = [];
    for (var i = 0; i < rawTokens.length; i++) {
      if (!seen.has(rawTokens[i])) {
        seen.add(rawTokens[i]);
        result.push(rawTokens[i]);
      }
    }
    return result;
  }

  function expandTokensWithSynonyms(tokens, synonymsMap) {
    if (!tokens || !tokens.length) return [];
    var synMap = synonymsMap || getSearchIndex().synonyms || {};
    var expanded = new Set();

    tokens.forEach(function (token) {
      expanded.add(token);

      // 1. Direct key lookup
      if (synMap[token] && Array.isArray(synMap[token])) {
        tokenizeQuery(token.replace(/_/g, " ")).forEach(function (t) {
          expanded.add(t);
        });
        synMap[token].forEach(function (syn) {
          tokenizeQuery(syn).forEach(function (t) {
            expanded.add(t);
          });
        });
      }

      // 2. Reverse variant match with whole-word boundary check & snake_case normalization
      Object.keys(synMap).forEach(function (key) {
        if (Array.isArray(synMap[key])) {
          var keyTokens = tokenizeQuery(key.replace(/_/g, " "));
          synMap[key].forEach(function (variant) {
            var varTokens = tokenizeQuery(variant);
            var isMatch = false;
            if (varTokens.length === 1) {
              isMatch = variant === token || varTokens[0] === token;
            } else if (varTokens.length > 1) {
              isMatch = varTokens.every(function (vt) {
                return tokens.includes(vt);
              });
            }
            if (isMatch) {
              keyTokens.forEach(function (t) {
                expanded.add(t);
              });
              varTokens.forEach(function (t) {
                expanded.add(t);
              });
              synMap[key].forEach(function (sibling) {
                tokenizeQuery(sibling).forEach(function (st) {
                  expanded.add(st);
                });
              });
            }
          });
        }
      });
    });

    return Array.from(expanded);
  }

  function scoreTextMatch(targetText, queryTokens, expandedTokens, weights) {
    if (!targetText || typeof targetText !== "string") return 0;
    var lower = targetText.toLowerCase();
    var targetTokens = tokenizeQuery(targetText);
    var score = 0;
    var directWeight = weights && weights.direct ? weights.direct : 10;
    var synWeight = weights && weights.synonym ? weights.synonym : 4;

    queryTokens.forEach(function (tok) {
      if (!tok) return;
      if (lower === tok) {
        score += directWeight * 3;
      } else if (targetTokens.includes(tok)) {
        score += directWeight * 2;
      } else if (tok.length > 2 && lower.indexOf(tok) !== -1) {
        score += directWeight;
      }
    });

    expandedTokens.forEach(function (tok) {
      if (!tok || queryTokens.includes(tok)) return;
      if (lower === tok) {
        score += synWeight * 3;
      } else if (targetTokens.includes(tok)) {
        score += synWeight * 2;
      } else if (tok.length > 2 && lower.indexOf(tok) !== -1) {
        score += synWeight;
      }
    });

    return score;
  }

  function searchGlobal(rawQuery) {
    if (!rawQuery || typeof rawQuery !== "string") {
      return {
        query: "",
        totalCount: 0,
        products: [],
        journal: [],
        events: [],
        faq: []
      };
    }
    var query = rawQuery.trim();
    if (!query) {
      return {
        query: "",
        totalCount: 0,
        products: [],
        journal: [],
        events: [],
        faq: []
      };
    }

    var index = getSearchIndex();
    var queryTokens = tokenizeQuery(query);
    var expandedTokens = expandTokensWithSynonyms(queryTokens, index.synonyms);

    // 1. Search Products
    var scoredProducts = (index.products || [])
      .map(function (prod) {
        var score = 0;
        score += scoreTextMatch(prod.name, queryTokens, expandedTokens, {
          direct: 30,
          synonym: 12
        });
        if (Array.isArray(prod.keywords)) {
          score += scoreTextMatch(prod.keywords.join(" "), queryTokens, expandedTokens, {
            direct: 20,
            synonym: 10
          });
        }
        if (Array.isArray(prod.concerns)) {
          score += scoreTextMatch(prod.concerns.join(" "), queryTokens, expandedTokens, {
            direct: 18,
            synonym: 9
          });
        }
        if (Array.isArray(prod.tags)) {
          score += scoreTextMatch(prod.tags.join(" "), queryTokens, expandedTokens, {
            direct: 15,
            synonym: 8
          });
        }
        if (prod.scent) {
          score += scoreTextMatch(prod.scent, queryTokens, expandedTokens, {
            direct: 14,
            synonym: 7
          });
        }
        if (Array.isArray(prod.ingredients)) {
          score += scoreTextMatch(prod.ingredients.join(" "), queryTokens, expandedTokens, {
            direct: 12,
            synonym: 6
          });
        }
        score += scoreTextMatch(prod.blurb || prod.description || "", queryTokens, expandedTokens, {
          direct: 8,
          synonym: 4
        });
        score += scoreTextMatch(prod.category || "", queryTokens, expandedTokens, {
          direct: 6,
          synonym: 3
        });

        if (prod.outOfStock || prod.stock === 0) {
          score = score * 0.7;
        }

        return { item: prod, score: score };
      })
      .filter(function (res) {
        return res.score > 0;
      })
      .sort(function (a, b) {
        return b.score - a.score;
      })
      .slice(0, 6)
      .map(function (res) {
        return res.item;
      });

    // 2. Search Journal
    var scoredJournal = (index.journal || [])
      .map(function (art) {
        var score = 0;
        score += scoreTextMatch(art.title, queryTokens, expandedTokens, {
          direct: 25,
          synonym: 10
        });
        if (Array.isArray(art.tags)) {
          score += scoreTextMatch(art.tags.join(" "), queryTokens, expandedTokens, {
            direct: 18,
            synonym: 8
          });
        }
        score += scoreTextMatch(art.excerpt || "", queryTokens, expandedTokens, {
          direct: 10,
          synonym: 5
        });
        score += scoreTextMatch(art.content || "", queryTokens, expandedTokens, {
          direct: 4,
          synonym: 2
        });
        return { item: art, score: score };
      })
      .filter(function (res) {
        return res.score > 0;
      })
      .sort(function (a, b) {
        return b.score - a.score;
      })
      .slice(0, 4)
      .map(function (res) {
        return res.item;
      });

    // 3. Search Events
    var scoredEvents = (index.events || [])
      .map(function (ev) {
        var score = 0;
        score += scoreTextMatch(ev.name || ev.title, queryTokens, expandedTokens, {
          direct: 25,
          synonym: 10
        });
        score += scoreTextMatch(ev.location || "", queryTokens, expandedTokens, {
          direct: 20,
          synonym: 8
        });
        score += scoreTextMatch(ev.type || "", queryTokens, expandedTokens, {
          direct: 15,
          synonym: 6
        });
        score += scoreTextMatch(ev.note || ev.description || "", queryTokens, expandedTokens, {
          direct: 10,
          synonym: 4
        });

        var eventKeywords = "market booth pop-up festival in-person calendar craft show fair pride";
        score += scoreTextMatch(eventKeywords, queryTokens, expandedTokens, {
          direct: 8,
          synonym: 4
        });

        if (ev.isUpcoming) {
          score = score * 1.25;
        }
        return { item: ev, score: score };
      })
      .filter(function (res) {
        return res.score > 0;
      })
      .sort(function (a, b) {
        return b.score - a.score;
      })
      .slice(0, 4)
      .map(function (res) {
        return res.item;
      });

    // 4. Search FAQ
    var scoredFaq = (index.faq || [])
      .map(function (f) {
        var score = 0;
        score += scoreTextMatch(f.question, queryTokens, expandedTokens, {
          direct: 25,
          synonym: 10
        });
        if (Array.isArray(f.keywords)) {
          score += scoreTextMatch(f.keywords.join(" "), queryTokens, expandedTokens, {
            direct: 18,
            synonym: 8
          });
        }
        score += scoreTextMatch(f.answer, queryTokens, expandedTokens, { direct: 10, synonym: 4 });
        score += scoreTextMatch(f.category || "", queryTokens, expandedTokens, {
          direct: 8,
          synonym: 3
        });
        return { item: f, score: score };
      })
      .filter(function (res) {
        return res.score > 0;
      })
      .sort(function (a, b) {
        return b.score - a.score;
      })
      .slice(0, 4)
      .map(function (res) {
        return res.item;
      });

    var totalCount =
      scoredProducts.length + scoredJournal.length + scoredEvents.length + scoredFaq.length;

    return {
      query: query,
      totalCount: totalCount,
      products: scoredProducts,
      journal: scoredJournal,
      events: scoredEvents,
      faq: scoredFaq
    };
  }

  function formatVariantChipLabel(prod, opt) {
    if (!prod || !opt) return "";
    var delta = Number(opt.priceDelta) || 0;
    var finalPrice = prod.price + delta;

    if (opt.label && opt.label.startsWith("$")) {
      return opt.label;
    }

    var hasDeltas =
      prod.variants &&
      Array.isArray(prod.variants.options) &&
      prod.variants.options.some(function (o) {
        return (Number(o.priceDelta) || 0) !== 0;
      });

    if (hasDeltas || delta !== 0) {
      return opt.label + " - $" + finalPrice.toFixed(2);
    }

    return opt.label;
  }

  function renderVariantChipsHtml(prod) {
    if (
      !prod ||
      !prod.variants ||
      !Array.isArray(prod.variants.options) ||
      prod.variants.options.length <= 1
    ) {
      return "";
    }

    var variantName = prod.variants.name || "Option";
    var pickerId = "search-variant-picker-" + attrEsc(prod.id);
    var html =
      '    <div class="search-variant-picker" id="' +
      pickerId +
      '" role="radiogroup" aria-label="' +
      attrEsc(variantName) +
      " for " +
      attrEsc(prod.name) +
      '" hidden>';
    html += '      <div class="search-variant-chips">';

    prod.variants.options.forEach(function (opt) {
      var delta = Number(opt.priceDelta) || 0;
      var finalPrice = prod.price + delta;
      var isSold = !!opt.soldOut;
      var chipText = formatVariantChipLabel(prod, opt);
      var chipAriaLabel =
        opt.label +
        (delta !== 0 ? " ($" + finalPrice.toFixed(2) + ")" : "") +
        (isSold ? " (Sold Out)" : "");

      html +=
        '        <button type="button" class="search-variant-chip' +
        (isSold ? " is-sold-out" : "") +
        '" role="radio" aria-checked="false"' +
        ' data-item-id="' +
        attrEsc(prod.id) +
        '" data-variant-name="' +
        attrEsc(variantName) +
        '" data-variant-label="' +
        attrEsc(opt.label) +
        '" data-variant-delta="' +
        delta +
        '" data-price="' +
        finalPrice.toFixed(2) +
        '"' +
        (isSold ? ' disabled aria-disabled="true"' : ' tabindex="-1"') +
        ' aria-label="' +
        attrEsc(chipAriaLabel) +
        '">' +
        escapeSearchHtml(chipText + (isSold ? " (Sold Out)" : "")) +
        "</button>";
    });

    html += "      </div>";
    html += "    </div>";
    return html;
  }

  function initGlobalSearchModal() {
    var modal = document.getElementById("global-search-modal");
    if (!modal) return;

    var input = document.getElementById("globalSearchInput");
    var clearBtn = document.getElementById("globalSearchClearBtn");
    var closeBtn = document.getElementById("globalSearchCloseBtn");
    var chipsSection = document.getElementById("globalSearchChipsSection");
    var resultsList = document.getElementById("globalSearchResultsList");
    var resultCount = document.getElementById("globalSearchResultCount");

    var lastFocusedElement = null;
    var debounceTimer = null;
    var selectedIndex = -1;
    var currentItems = [];

    function openModal(initialQuery) {
      lastFocusedElement = document.activeElement;
      if (typeof modal.showModal === "function") {
        modal.showModal();
      } else {
        modal.setAttribute("open", "");
      }

      var triggers = document.querySelectorAll(
        "#globalSearchTrigger, [data-action='open-global-search']"
      );
      triggers.forEach(function (btn) {
        btn.setAttribute("aria-expanded", "true");
      });

      if (input) {
        if (typeof initialQuery === "string") {
          input.value = initialQuery;
          triggerSearch(initialQuery);
        } else if (!input.value) {
          if (chipsSection) chipsSection.hidden = false;
          if (resultsList) resultsList.innerHTML = "";
          if (clearBtn) clearBtn.hidden = true;
          if (resultCount) resultCount.textContent = "";
          input.setAttribute("aria-expanded", "false");
        } else {
          triggerSearch(input.value);
        }

        setTimeout(function () {
          input.focus();
          if (input.value) input.select();
        }, 50);
      }
    }

    function closeModal() {
      if (typeof modal.close === "function") {
        modal.close();
      } else {
        modal.removeAttribute("open");
      }

      var triggers = document.querySelectorAll(
        "#globalSearchTrigger, [data-action='open-global-search']"
      );
      triggers.forEach(function (btn) {
        btn.setAttribute("aria-expanded", "false");
      });

      var openPickers = modal.querySelectorAll(".search-item-action.is-expanded");
      openPickers.forEach(function (wrap) {
        wrap.classList.remove("is-expanded");
        var trg = wrap.querySelector(".search-variant-trigger");
        if (trg) trg.setAttribute("aria-expanded", "false");
        var pck = wrap.querySelector(".search-variant-picker");
        if (pck) pck.hidden = true;
      });

      selectedIndex = -1;
      if (input) {
        input.removeAttribute("aria-activedescendant");
        input.setAttribute("aria-expanded", "false");
      }

      if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
        lastFocusedElement.focus();
      }
    }

    function triggerSearch(query) {
      var trimmed = (query || "").trim();
      if (!trimmed) {
        if (chipsSection) chipsSection.hidden = false;
        if (resultsList) resultsList.innerHTML = "";
        if (clearBtn) clearBtn.hidden = true;
        if (resultCount) resultCount.textContent = "";
        if (input) {
          input.setAttribute("aria-expanded", "false");
          input.removeAttribute("aria-activedescendant");
        }
        currentItems = [];
        selectedIndex = -1;
        return;
      }

      if (chipsSection) chipsSection.hidden = true;
      if (clearBtn) clearBtn.hidden = false;

      var results = searchGlobal(trimmed);
      renderResults(results);
    }

    function renderResults(results) {
      if (!resultsList) return;
      currentItems = [];
      selectedIndex = -1;

      if (results.totalCount === 0) {
        resultsList.innerHTML =
          '<div class="search-empty-state">' +
          '  <svg class="yl-icon search-empty-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
          '  <h3 class="search-empty-title">No potion found for &ldquo;' +
          escapeSearchHtml(results.query) +
          "&rdquo;</h3>" +
          '  <p class="search-empty-text">Looking for sleep, sore muscles, bug defense, or upcoming pop-up markets? Try one of these popular searches:</p>' +
          '  <div class="search-empty-suggestions">' +
          '    <button type="button" class="search-chip" data-search-query="sleep"><svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg><span>Bedtime &amp; Sleep</span></button>' +
          '    <button type="button" class="search-chip" data-search-query="sore muscles"><svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg><span>Sore Muscles</span></button>' +
          '    <button type="button" class="search-chip" data-search-query="dry skin"><svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg><span>Dry Skin &amp; Eczema</span></button>' +
          '    <button type="button" class="search-chip" data-search-query="bug spray"><svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg><span>Bug Defense</span></button>' +
          '    <button type="button" class="search-chip" data-search-query="events"><svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg><span>Pop-Up Markets</span></button>' +
          '    <button type="button" class="search-chip" data-search-query="gift card"><svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 12 20 22 4 22 4 12"></polyline><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg><span>Gift Cards</span></button>' +
          "  </div>" +
          "</div>";

        if (resultCount) {
          resultCount.textContent = "No results found for " + results.query;
        }
        if (input) {
          input.setAttribute("aria-expanded", "false");
          input.removeAttribute("aria-activedescendant");
        }
        return;
      }

      var html = "";
      var globalIdx = 0;

      // 1. Products Section
      if (results.products.length > 0) {
        html +=
          '<div class="search-results-section" role="group" aria-labelledby="search-section-products-title">';
        html += '  <div class="search-section-header" id="search-section-products-title">';
        html +=
          '    <span><svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg> Products</span>';
        html += '    <span class="search-section-count">' + results.products.length + "</span>";
        html += "  </div>";
        results.products.forEach(function (prod) {
          var itemOptId = "search-opt-" + globalIdx;
          currentItems.push({ id: itemOptId, url: prod.url, type: "product", item: prod });

          var priceStr = "$" + prod.price.toFixed(2);
          var stockBadge = prod.outOfStock
            ? '<span class="stock-badge out-of-stock">Sold Out</span>'
            : '<span class="stock-badge in-stock">In Stock</span>';

          var hasVariants =
            !prod.outOfStock &&
            prod.variants &&
            Array.isArray(prod.variants.options) &&
            prod.variants.options.length > 1;

          html +=
            '<div class="search-result-item" id="' +
            itemOptId +
            '" role="option" aria-selected="false" data-item-index="' +
            globalIdx +
            '" data-url="' +
            attrEsc(prod.url) +
            '">';
          html += '  <a href="' + attrEsc(prod.url) + '" class="search-item-main">';
          html +=
            '    <img src="' +
            attrEsc(prod.image) +
            '" alt="' +
            attrEsc(prod.name) +
            '" class="search-item-thumb" width="52" height="52" loading="lazy">';
          html += '    <div class="search-item-info">';
          html += '      <h4 class="search-item-title">' + escapeSearchHtml(prod.name) + "</h4>";
          html += '      <div class="search-item-meta">';
          html += '        <span class="search-item-price">' + priceStr + "</span>";
          html += "        " + stockBadge;
          html += "      </div>";
          if (prod.blurb) {
            html += '      <p class="search-item-blurb">' + escapeSearchHtml(prod.blurb) + "</p>";
          }
          html += "    </div>";
          html += "  </a>";
          html += '  <div class="search-item-action" data-product-id="' + attrEsc(prod.id) + '">';
          if (!prod.outOfStock) {
            if (hasVariants) {
              var pickerId = "search-variant-picker-" + attrEsc(prod.id);
              var variantName = prod.variants.name || "Option";
              html +=
                '    <button type="button" class="btn btn-primary btn-sm search-add-btn search-variant-trigger"' +
                ' data-item-id="' +
                attrEsc(prod.id) +
                '" data-has-variants="true" aria-expanded="false" aria-controls="' +
                pickerId +
                '" aria-label="Select ' +
                attrEsc(variantName) +
                " for " +
                attrEsc(prod.name) +
                '">' +
                "+ Add</button>";
              html += renderVariantChipsHtml(prod);
            } else {
              html +=
                '    <button type="button" class="btn btn-primary btn-sm yl-add-item search-add-btn"' +
                ' data-item-id="' +
                attrEsc(prod.id) +
                '"' +
                ' data-item-name="' +
                attrEsc(prod.name) +
                '"' +
                ' data-item-price="' +
                prod.price.toFixed(2) +
                '"' +
                ' data-item-image="' +
                attrEsc(prod.image) +
                '"' +
                ' data-item-description="' +
                attrEsc(prod.blurb || "") +
                '"' +
                ' data-item-url="' +
                attrEsc(prod.url || "") +
                '">' +
                "+ Add</button>";
            }
          }
          html += "  </div>";
          html += "</div>";
          globalIdx++;
        });
        html += "</div>";
      }

      // 2. Journal Section
      if (results.journal.length > 0) {
        html +=
          '<div class="search-results-section" role="group" aria-labelledby="search-section-journal-title">';
        html += '  <div class="search-section-header" id="search-section-journal-title">';
        html +=
          '    <span><svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg> Apothecary Journal</span>';
        html += '    <span class="search-section-count">' + results.journal.length + "</span>";
        html += "  </div>";
        results.journal.forEach(function (art) {
          var itemOptId = "search-opt-" + globalIdx;
          currentItems.push({ id: itemOptId, url: art.url, type: "journal", item: art });

          html +=
            '<div class="search-result-item" id="' +
            itemOptId +
            '" role="option" aria-selected="false" data-item-index="' +
            globalIdx +
            '" data-url="' +
            attrEsc(art.url) +
            '">';
          html += '  <a href="' + attrEsc(art.url) + '" class="search-item-main">';
          html +=
            '    <div class="search-faq-icon" aria-hidden="true"><svg class="yl-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></div>';
          html += '    <div class="search-item-info">';
          html += '      <h4 class="search-item-title">' + escapeSearchHtml(art.title) + "</h4>";
          html += '      <div class="search-item-meta">';
          if (art.readTime) {
            html +=
              '        <span class="search-tag-pill">' + escapeSearchHtml(art.readTime) + "</span>";
          }
          if (art.date) {
            html +=
              '        <span class="search-tag-pill">' + escapeSearchHtml(art.date) + "</span>";
          }
          html += "      </div>";
          if (art.excerpt) {
            html += '      <p class="search-item-blurb">' + escapeSearchHtml(art.excerpt) + "</p>";
          }
          html += "    </div>";
          html += "  </a>";
          html += "</div>";
          globalIdx++;
        });
        html += "</div>";
      }

      // 3. Markets & Events Section
      if (results.events.length > 0) {
        html +=
          '<div class="search-results-section" role="group" aria-labelledby="search-section-events-title">';
        html += '  <div class="search-section-header" id="search-section-events-title">';
        html +=
          '    <span><svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> Markets &amp; Events</span>';
        html += '    <span class="search-section-count">' + results.events.length + "</span>";
        html += "  </div>";
        results.events.forEach(function (ev) {
          var itemOptId = "search-opt-" + globalIdx;
          currentItems.push({ id: itemOptId, url: ev.url, type: "event", item: ev });

          html +=
            '<div class="search-result-item" id="' +
            itemOptId +
            '" role="option" aria-selected="false" data-item-index="' +
            globalIdx +
            '" data-url="' +
            attrEsc(ev.url) +
            '">';
          html += '  <a href="' + attrEsc(ev.url) + '" class="search-item-main">';
          html +=
            '    <div class="search-event-badge"><span class="event-badge-day">' +
            escapeSearchHtml(ev.dateLabel || ev.date || "") +
            "</span></div>";
          html += '    <div class="search-item-info">';
          html +=
            '      <h4 class="search-item-title">' +
            escapeSearchHtml(ev.name || ev.title) +
            "</h4>";
          html += '      <div class="search-item-meta">';
          if (ev.location) {
            html += "        <span>" + escapeSearchHtml(ev.location) + "</span>";
          }
          if (ev.type) {
            html +=
              '        <span class="search-tag-pill">' + escapeSearchHtml(ev.type) + "</span>";
          }
          html += "      </div>";
          if (ev.note || ev.description) {
            html +=
              '      <p class="search-item-blurb">' +
              escapeSearchHtml(ev.note || ev.description) +
              "</p>";
          }
          html += "    </div>";
          html += "  </a>";
          html += "</div>";
          globalIdx++;
        });
        html += "</div>";
      }

      // 4. FAQ Section
      if (results.faq.length > 0) {
        html +=
          '<div class="search-results-section" role="group" aria-labelledby="search-section-faq-title">';
        html += '  <div class="search-section-header" id="search-section-faq-title">';
        html +=
          '    <span><svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> FAQ &amp; Help</span>';
        html += '    <span class="search-section-count">' + results.faq.length + "</span>";
        html += "  </div>";
        results.faq.forEach(function (f) {
          var itemOptId = "search-opt-" + globalIdx;
          currentItems.push({ id: itemOptId, url: f.url, type: "faq", item: f });

          html +=
            '<div class="search-result-item" id="' +
            itemOptId +
            '" role="option" aria-selected="false" data-item-index="' +
            globalIdx +
            '" data-url="' +
            attrEsc(f.url) +
            '">';
          html += '  <a href="' + attrEsc(f.url) + '" class="search-item-main">';
          html +=
            '    <div class="search-faq-icon" aria-hidden="true"><svg class="yl-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>';
          html += '    <div class="search-item-info">';
          html += '      <h4 class="search-item-title">' + escapeSearchHtml(f.question) + "</h4>";
          if (f.category) {
            html +=
              '      <div class="search-item-meta"><span class="search-tag-pill">' +
              escapeSearchHtml(f.category) +
              "</span></div>";
          }
          if (f.answer) {
            html += '      <p class="search-item-blurb">' + escapeSearchHtml(f.answer) + "</p>";
          }
          html += "    </div>";
          html += "  </a>";
          html += "</div>";
          globalIdx++;
        });
        html += "</div>";
      }

      resultsList.innerHTML = html;

      // Screen reader announcement
      if (resultCount) {
        var summary =
          "Found " +
          results.products.length +
          " products, " +
          results.journal.length +
          " articles, " +
          results.events.length +
          " events, and " +
          results.faq.length +
          " FAQs for " +
          results.query;
        resultCount.textContent = summary;
      }

      if (input) {
        input.setAttribute("aria-expanded", "true");
      }
    }

    function selectOption(index, scrollIntoView) {
      if (!currentItems.length) {
        selectedIndex = -1;
        if (input) input.removeAttribute("aria-activedescendant");
        return;
      }

      if (index < 0) index = currentItems.length - 1;
      if (index >= currentItems.length) index = 0;

      selectedIndex = index;
      var activeItemMeta = currentItems[selectedIndex];

      var items = resultsList ? resultsList.querySelectorAll(".search-result-item") : [];
      items.forEach(function (el, idx) {
        if (idx === selectedIndex) {
          el.classList.add("is-selected");
          el.setAttribute("aria-selected", "true");
          if (scrollIntoView && typeof el.scrollIntoView === "function") {
            el.scrollIntoView({ block: "nearest", behavior: "smooth" });
          }
        } else {
          el.classList.remove("is-selected");
          el.setAttribute("aria-selected", "false");
        }
      });

      if (input && activeItemMeta) {
        input.setAttribute("aria-activedescendant", activeItemMeta.id);
      }
    }

    function executeOption(index) {
      if (index < 0 || index >= currentItems.length) return;
      var activeItemMeta = currentItems[index];
      if (activeItemMeta && activeItemMeta.url) {
        closeModal();
        window.location.href = activeItemMeta.url;
      }
    }

    // Event Listeners
    document.addEventListener("click", function (e) {
      var trigger = e.target.closest("#globalSearchTrigger, [data-action='open-global-search']");
      if (trigger) {
        e.preventDefault();
        openModal();
        return;
      }

      // Quick chip clicks (inside modal or empty state)
      var chip = e.target.closest(".search-chip");
      if (chip) {
        var query = chip.getAttribute("data-search-query") || chip.textContent.trim();
        if (input) {
          input.value = query;
          triggerSearch(query);
          input.focus();
        }
      }
    });

    if (closeBtn) {
      closeBtn.addEventListener("click", function (e) {
        e.preventDefault();
        closeModal();
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener("click", function (e) {
        e.preventDefault();
        if (input) {
          input.value = "";
          triggerSearch("");
          input.focus();
        }
      });
    }

    modal.addEventListener("click", function (e) {
      if (e.target === modal) {
        closeModal();
      }
    });

    if (input) {
      input.addEventListener("input", function () {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function () {
          triggerSearch(input.value);
        }, 150);
      });

      input.addEventListener("keydown", function (e) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          selectOption(selectedIndex + 1, true);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          selectOption(selectedIndex <= 0 ? currentItems.length - 1 : selectedIndex - 1, true);
        } else if (e.key === "Enter") {
          if (selectedIndex >= 0) {
            e.preventDefault();
            executeOption(selectedIndex);
          } else if (currentItems.length > 0) {
            e.preventDefault();
            executeOption(0);
          }
        }
      });
    }

    // Focus trapping and modal keydown handler
    modal.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal();
        return;
      }

      if (e.key === "Tab") {
        var allFocusables = Array.from(
          modal.querySelectorAll(
            'input:not([disabled]):not([type="hidden"]), button:not([hidden]):not([disabled]), a[href], [tabindex]:not([disabled])'
          )
        );
        var focusables = allFocusables.filter(function (el) {
          if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
          if (el.tabIndex < 0 || el.getAttribute("tabindex") === "-1") return false;
          if (el.closest("[hidden], [style*='display: none'], .is-hidden")) return false;
          return true;
        });
        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }
        var first = focusables[0];
        var last = focusables[focusables.length - 1];

        if (focusables.length === 1) {
          e.preventDefault();
          first.focus();
          return;
        }

        if (e.shiftKey) {
          if (document.activeElement === first || !focusables.includes(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last || !focusables.includes(document.activeElement)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    });

    // Global keyboard shortcuts: Cmd+K / Ctrl+K and guarded /
    document.addEventListener("keydown", function (e) {
      var isMac =
        typeof navigator !== "undefined" && /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform);
      var isCmdK = (isMac ? e.metaKey : e.ctrlKey) && (e.key === "k" || e.key === "K");

      if (isCmdK) {
        e.preventDefault();
        if (modal.hasAttribute("open")) {
          closeModal();
        } else {
          openModal();
        }
        return;
      }

      if (e.key === "/") {
        var activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : "";
        var isEditable =
          document.activeElement &&
          (activeTag === "input" ||
            activeTag === "textarea" ||
            activeTag === "select" ||
            document.activeElement.isContentEditable);
        var anyDialogOpen = !!document.querySelector("dialog[open]");

        if (!isEditable && !anyDialogOpen) {
          e.preventDefault();
          openModal();
        }
      }
    });

    // Variant Picker and Add to Cart interactions
    if (resultsList) {
      resultsList.addEventListener("click", function (e) {
        // 1. Variant Trigger Button click
        var variantTrigger = e.target.closest(".search-variant-trigger");
        if (variantTrigger) {
          e.preventDefault();
          e.stopPropagation();
          var actionWrap = variantTrigger.closest(".search-item-action");
          if (actionWrap) {
            var picker = actionWrap.querySelector(".search-variant-picker");
            if (picker) {
              var allOpenActions = resultsList.querySelectorAll(".search-item-action.is-expanded");
              allOpenActions.forEach(function (openAction) {
                if (openAction !== actionWrap) {
                  openAction.classList.remove("is-expanded");
                  var otherTrigger = openAction.querySelector(".search-variant-trigger");
                  if (otherTrigger) otherTrigger.setAttribute("aria-expanded", "false");
                  var otherPicker = openAction.querySelector(".search-variant-picker");
                  if (otherPicker) otherPicker.hidden = true;
                }
              });

              actionWrap.classList.add("is-expanded");
              variantTrigger.setAttribute("aria-expanded", "true");
              picker.hidden = false;

              var chips = Array.from(
                picker.querySelectorAll(".search-variant-chip:not([disabled])")
              );
              if (chips.length > 0) {
                chips.forEach(function (c, idx) {
                  c.setAttribute("tabindex", idx === 0 ? "0" : "-1");
                });
                setTimeout(function () {
                  chips[0].focus();
                }, 30);
              }
            }
          }
          return;
        }

        // 2. Variant Chip click
        var chip = e.target.closest(".search-variant-chip");
        if (chip) {
          e.preventDefault();
          e.stopPropagation();
          if (chip.disabled || chip.classList.contains("is-sold-out")) {
            return;
          }

          var itemId = chip.getAttribute("data-item-id");
          var variantName = chip.getAttribute("data-variant-name") || "";
          var variantLabel = chip.getAttribute("data-variant-label") || "";
          var variantDelta = Number(chip.getAttribute("data-variant-delta")) || 0;

          var index = getSearchIndex();
          var prod = (index.products || []).find(function (p) {
            return p.id === itemId;
          });

          if (prod) {
            if (
              typeof window !== "undefined" &&
              window.YLCart &&
              typeof window.YLCart.addItem === "function"
            ) {
              window.YLCart.addItem({
                id: prod.id,
                name: prod.name,
                price: prod.price,
                image: prod.image,
                category: prod.category,
                variantName: variantName || (prod.variants ? prod.variants.name : ""),
                variantLabel: variantLabel,
                variantDelta: variantDelta,
                maxQty: prod.stock || null,
                qty: 1
              });
            }

            var chipPicker = chip.closest(".search-variant-picker");
            if (chipPicker) {
              var allChips = chipPicker.querySelectorAll(".search-variant-chip");
              allChips.forEach(function (c) {
                c.setAttribute("aria-checked", c === chip ? "true" : "false");
              });
            }
            chip.classList.add("is-added");
            var originalText = chip.textContent;
            chip.textContent = "✓ Added";
            setTimeout(function () {
              chip.classList.remove("is-added");
              chip.textContent = originalText;
            }, 1000);
          }
          return;
        }

        // 3. Regular Add Button click (single items)
        var addBtn = e.target.closest(".search-add-btn:not(.search-variant-trigger)");
        if (addBtn) {
          addBtn.classList.add("is-added");
          var orig = addBtn.textContent;
          addBtn.textContent = "✓ Added";
          setTimeout(function () {
            addBtn.classList.remove("is-added");
            addBtn.textContent = orig;
          }, 1200);
        }
      });

      // Keyboard navigation for chips inside picker
      resultsList.addEventListener("keydown", function (e) {
        var chip = e.target.closest(".search-variant-chip");
        if (chip) {
          var picker = chip.closest(".search-variant-picker");
          if (!picker) return;
          var actionWrap = picker.closest(".search-item-action");
          var chips = Array.from(picker.querySelectorAll(".search-variant-chip:not([disabled])"));
          var currentIdx = chips.indexOf(chip);

          if (e.key === "ArrowRight" || e.key === "ArrowDown") {
            e.preventDefault();
            if (chips.length > 0) {
              var nextIdx = (currentIdx + 1) % chips.length;
              chips.forEach(function (c, idx) {
                c.setAttribute("tabindex", idx === nextIdx ? "0" : "-1");
              });
              chips[nextIdx].focus();
            }
          } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
            e.preventDefault();
            if (chips.length > 0) {
              var prevIdx = (currentIdx - 1 + chips.length) % chips.length;
              chips.forEach(function (c, idx) {
                c.setAttribute("tabindex", idx === prevIdx ? "0" : "-1");
              });
              chips[prevIdx].focus();
            }
          } else if (e.key === " " || e.key === "Enter" || e.key === "Spacebar") {
            e.preventDefault();
            chip.click();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (actionWrap) {
              actionWrap.classList.remove("is-expanded");
              picker.hidden = true;
              var trigger = actionWrap.querySelector(".search-variant-trigger");
              if (trigger) {
                trigger.setAttribute("aria-expanded", "false");
                trigger.focus();
              }
            }
          }
        }
      });
    }
  }
  initGlobalSearchModal();

  /* ==================== SPECULATIVE HOVER PREFETCH CONTROLLER (M3) ==================== */
  function initHoverPrefetch() {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return {
        prefetchUrl: function () {},
        getPrefetchedUrls: function () {
          return [];
        },
        isPrefetched: function () {
          return false;
        },
        clearPrefetchCache: function () {},
        _canPrefetch: function () {
          return false;
        },
        _getCleanCandidateUrl: function () {
          return null;
        }
      };
    }

    var prefetchedUrls = new Set();
    var hoverTimer = null;
    var currentCandidateUrl = null;
    var DEBOUNCE_MS = 65;

    function canPrefetch() {
      var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (conn) {
        if (conn.saveData === true) return false;
        var et = String(conn.effectiveType || "").toLowerCase();
        if (et === "slow-2g" || et === "2g" || et === "3g") return false;
      }
      return true;
    }

    function getCleanCandidateUrl(linkEl) {
      if (!linkEl) return null;
      var href = linkEl.getAttribute("href");
      if (!href || typeof href !== "string") return null;
      var trimmed = href.trim();
      if (
        !trimmed ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("javascript:") ||
        trimmed.startsWith("mailto:") ||
        trimmed.startsWith("tel:") ||
        trimmed.startsWith("blob:") ||
        trimmed.startsWith("data:")
      ) {
        return null;
      }
      if (linkEl.getAttribute("rel") && linkEl.getAttribute("rel").includes("nofollow")) {
        return null;
      }
      if (linkEl.hasAttribute("download") || linkEl.hasAttribute("data-no-prefetch")) {
        return null;
      }

      try {
        var resolved = new URL(linkEl.href, window.location.href);
        if (resolved.origin !== window.location.origin) return null;
        if (
          resolved.pathname.startsWith("/api/") ||
          resolved.pathname.startsWith("/admin") ||
          resolved.pathname.startsWith("/.netlify/")
        ) {
          return null;
        }
        if (
          resolved.pathname === window.location.pathname &&
          resolved.search === window.location.search
        ) {
          return null;
        }
        return resolved.pathname + resolved.search;
      } catch {
        return null;
      }
    }

    function prefetchUrl(url) {
      if (!url || typeof url !== "string" || prefetchedUrls.has(url) || !canPrefetch()) {
        return false;
      }
      prefetchedUrls.add(url);

      try {
        var supportsSpeculation =
          typeof HTMLScriptElement !== "undefined" &&
          typeof HTMLScriptElement.supports === "function" &&
          HTMLScriptElement.supports("speculationrules");

        if (supportsSpeculation) {
          var script = document.createElement("script");
          script.type = "speculationrules";
          script.textContent = JSON.stringify({
            prefetch: [
              {
                source: "list",
                urls: [url]
              }
            ]
          });
          document.head.appendChild(script);
        } else {
          var link = document.createElement("link");
          link.rel = "prefetch";
          link.href = url;
          link.as = "document";
          document.head.appendChild(link);
        }
        return true;
      } catch {
        return false;
      }
    }

    function onPointerEnter(e) {
      if (!e.target || typeof e.target.closest !== "function") return;
      var link = e.target.closest("a[href]");
      if (!link) return;
      var url = getCleanCandidateUrl(link);
      if (!url || prefetchedUrls.has(url)) return;

      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
      currentCandidateUrl = url;
      hoverTimer = setTimeout(function () {
        if (currentCandidateUrl === url) {
          prefetchUrl(url);
        }
      }, DEBOUNCE_MS);
    }

    function onPointerLeave(e) {
      if (!e.target || typeof e.target.closest !== "function") return;
      var link = e.target.closest("a[href]");
      if (link) {
        if (hoverTimer) {
          clearTimeout(hoverTimer);
          hoverTimer = null;
        }
        currentCandidateUrl = null;
      }
    }

    document.addEventListener("pointerenter", onPointerEnter, { capture: true, passive: true });
    document.addEventListener("pointerleave", onPointerLeave, { capture: true, passive: true });
    document.addEventListener("focusin", onPointerEnter, { capture: true, passive: true });
    document.addEventListener("focusout", onPointerLeave, { capture: true, passive: true });

    return {
      prefetchUrl: prefetchUrl,
      getPrefetchedUrls: function () {
        return Array.from(prefetchedUrls);
      },
      isPrefetched: function (url) {
        return prefetchedUrls.has(url);
      },
      clearPrefetchCache: function () {
        prefetchedUrls.clear();
        if (hoverTimer) {
          clearTimeout(hoverTimer);
          hoverTimer = null;
        }
        currentCandidateUrl = null;
      },
      _canPrefetch: canPrefetch,
      _getCleanCandidateUrl: getCleanCandidateUrl
    };
  }

  /* ---------- Recently Viewed Products (localStorage + scroll-snap carousel) ---------- */
  var RECENTLY_VIEWED_KEY = "yl-recently-viewed";
  var MAX_RECENTLY_VIEWED = 8;
  var recentlyViewedCache = null;

  /**
   * Retrieves the current list of recently viewed product objects from cache / localStorage.
   *
   * @return {!Array<!Object>} Array of recently viewed product objects.
   */
  function getRecentlyViewed() {
    if (recentlyViewedCache !== null) return recentlyViewedCache;
    try {
      var raw = localStorage.getItem(RECENTLY_VIEWED_KEY);
      recentlyViewedCache = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(recentlyViewedCache)) recentlyViewedCache = [];
    } catch {
      recentlyViewedCache = [];
    }
    return recentlyViewedCache;
  }

  /**
   * Records a product visit in localStorage["yl-recently-viewed"].
   * Deduplicates by product ID, unshifts to index 0, caps at 8 items.
   * Handles private browsing mode / storage quota errors safely.
   *
   * @param {!Object} product The product details to record.
   * @return {!Array<!Object>} The updated list of recently viewed items.
   */
  function recordRecentlyViewed(product) {
    if (!product || typeof product !== "object" || !product.id) {
      return getRecentlyViewed();
    }
    var list = getRecentlyViewed().slice();
    list = list.filter(function (item) {
      return item && item.id !== product.id;
    });
    var entry = {
      id: String(product.id),
      name: product.name ? String(product.name) : String(product.id),
      price: typeof product.price === "number" ? product.price : parseFloat(product.price) || 0,
      image: product.image ? String(product.image).replace(/^\.\.\//, "") : "",
      category: product.category ? String(product.category) : "",
      timestamp: typeof product.timestamp === "number" ? product.timestamp : Date.now()
    };
    if (product.priceRange) {
      entry.priceRange = String(product.priceRange);
    }
    list.unshift(entry);
    if (list.length > MAX_RECENTLY_VIEWED) {
      list = list.slice(0, MAX_RECENTLY_VIEWED);
    }
    recentlyViewedCache = list;
    try {
      localStorage.setItem(RECENTLY_VIEWED_KEY, JSON.stringify(list));
    } catch {
      /* storage unavailable or quota exceeded */
    }
    return list;
  }

  /**
   * Renders the Recently Viewed Carousel into #recently-viewed-section (shop.html)
   * or #pdpRecentlyViewedSection (PDP pages) if >= 2 items are available.
   */
  function renderRecentlyViewedCarousel() {
    var shopSection = document.getElementById("recently-viewed-section");
    var pdpSection = document.getElementById("pdpRecentlyViewedSection");
    if (!shopSection && !pdpSection) return;

    var isPdp =
      (typeof document !== "undefined" &&
        document.body &&
        document.body.classList.contains("pdp-page")) ||
      (!!pdpSection && !shopSection);
    var currentPdpId = "";
    if (
      isPdp &&
      typeof window !== "undefined" &&
      window.location &&
      typeof window.location.pathname === "string"
    ) {
      currentPdpId = window.location.pathname
        .split("/")
        .pop()
        .replace(".html", "")
        .replace(/^[#/]/, "");
    }

    var list = getRecentlyViewed();
    var displayList = list;
    if (isPdp && currentPdpId) {
      displayList = list.filter(function (item) {
        return item && item.id !== currentPdpId;
      });
    }

    var targetSection = isPdp ? pdpSection || shopSection : shopSection;
    if (!targetSection) return;

    var track =
      targetSection.querySelector(".recently-viewed-track") ||
      targetSection.querySelector("#recentlyViewedTrack") ||
      targetSection.querySelector("#pdpRecentlyViewedTrack");

    if (displayList.length < 2) {
      targetSection.hidden = true;
      targetSection.setAttribute("hidden", "");
      if (track) track.innerHTML = "";
      return;
    }

    targetSection.hidden = false;
    targetSection.removeAttribute("hidden");
    if (!track) return;

    var catLabels = {
      apparel: "Apparel",
      salves: "Salves & Balms",
      body: "Body & Skin",
      soaks: "Soaks",
      potions: "Potions & Spellwork",
      ritual: "Ritual & Home",
      "gift-cards": "Gift Cards"
    };

    var html = displayList
      .map(function (item) {
        var cat = catLabels[item.category] || item.category || "Handmade";
        var imgSrc = item.image || "assets/img/logo.png";
        if (
          isPdp &&
          !imgSrc.startsWith("http") &&
          !imgSrc.startsWith("../") &&
          !imgSrc.startsWith("/")
        ) {
          imgSrc = "../" + imgSrc;
        }
        var pdpUrl = (isPdp ? "" : "products/") + attrEsc(item.id) + ".html";
        var priceDisplay = item.priceRange
          ? attrEsc(item.priceRange)
          : "$" + (typeof item.price === "number" ? item.price.toFixed(2) : "0.00");

        return (
          '<div class="card recently-viewed-card" data-id="' +
          attrEsc(item.id) +
          '">' +
          '  <div class="recently-viewed-media">' +
          '    <a href="' +
          pdpUrl +
          '" tabindex="-1" aria-hidden="true">' +
          '      <img class="recently-viewed-img" src="' +
          attrEsc(imgSrc) +
          '" alt="' +
          attrEsc(item.name) +
          '" width="240" height="240" loading="lazy">' +
          "    </a>" +
          "  </div>" +
          '  <div class="recently-viewed-body">' +
          '    <span class="recently-viewed-cat">' +
          attrEsc(cat) +
          "</span>" +
          '    <h3 class="recently-viewed-title"><a href="' +
          pdpUrl +
          '">' +
          attrEsc(item.name) +
          "</a></h3>" +
          '    <div class="recently-viewed-foot">' +
          '      <span class="price">' +
          priceDisplay +
          "</span>" +
          '      <a href="' +
          pdpUrl +
          '" class="btn btn-outline btn-sm recently-viewed-btn">View</a>' +
          "    </div>" +
          "  </div>" +
          "</div>"
        );
      })
      .join("");

    track.innerHTML = html;
  }

  /**
   * Initializes recently viewed recording on PDP and renders carousels.
   */
  function initRecentlyViewed() {
    if (typeof document === "undefined") return;

    var isPdp =
      (document.body && document.body.classList.contains("pdp-page")) ||
      !!document.querySelector(".pdp-layout");

    if (isPdp) {
      var pathId = "";
      if (
        typeof window !== "undefined" &&
        window.location &&
        typeof window.location.pathname === "string"
      ) {
        pathId = window.location.pathname
          .split("/")
          .pop()
          .replace(".html", "")
          .replace(/^[#/]/, "");
      }
      var pMap = getProductMap();
      var prod = pMap.get(pathId);
      if (!prod && window.YL_SEARCH_INDEX && Array.isArray(window.YL_SEARCH_INDEX.products)) {
        prod = window.YL_SEARCH_INDEX.products.find(function (p) {
          return p && p.id === pathId;
        });
      }
      if (prod) {
        recordRecentlyViewed(prod);
      } else if (pathId) {
        var titleEl = document.querySelector(".pdp-title") || document.querySelector("h1");
        var priceEl = document.querySelector(".pdp-price");
        var imgEl = document.querySelector(".pdp-main-image");
        var catEl = document.querySelector(".pdp-details .eyebrow");
        var domProduct = {
          id: pathId,
          name: titleEl ? titleEl.textContent.trim() : pathId,
          price: priceEl ? parseFloat(priceEl.textContent.replace(/[^0-9.]/g, "")) || 0 : 0,
          image: imgEl ? imgEl.getAttribute("src") : "",
          category: catEl ? catEl.textContent.trim().toLowerCase() : ""
        };
        recordRecentlyViewed(domProduct);
      }
    }

    renderRecentlyViewedCarousel();
  }

  /**
   * Milestone 4 / R2: "Complete the Ritual" Smart Cross-Sells
   * Renders compact modal ritual bundle HTML for the shop quick-view / photo viewer.
   */
  function renderModalRitualHtml(product, pMap) {
    if (!product || !Array.isArray(product.pairsWith) || !product.pairsWith.length) {
      return "";
    }
    var map = pMap || getProductMap();
    var pairedItems = product.pairsWith
      .map(function (id) {
        return map ? map.get(id) : null;
      })
      .filter(Boolean);
    if (!pairedItems.length) return "";

    var total = typeof product.price === "number" ? product.price : 0;
    pairedItems.forEach(function (it) {
      total += typeof it.price === "number" ? it.price : 0;
    });

    var allIds = [product.id]
      .concat(
        pairedItems.map(function (p) {
          return p.id;
        })
      )
      .join(",");

    var itemsHtml =
      '<label class="pdp-ritual-item is-checked" data-product-id="' +
      attrEsc(product.id) +
      '">' +
      '<input type="checkbox" class="pdp-ritual-checkbox" checked disabled aria-label="Include ' +
      attrEsc(product.name) +
      ' (Current product)" data-price="' +
      (typeof product.price === "number" ? product.price.toFixed(2) : "0.00") +
      '">' +
      '<div class="pdp-ritual-item-thumb"><img src="' +
      attrEsc(product.image || "") +
      '" alt="" width="44" height="44" loading="lazy"></div>' +
      '<div class="pdp-ritual-item-details">' +
      '<span class="pdp-ritual-item-tag">This Item</span>' +
      '<span class="pdp-ritual-item-name">' +
      attrEsc(product.name) +
      "</span>" +
      '<span class="pdp-ritual-item-price">$' +
      (typeof product.price === "number" ? product.price.toFixed(2) : "0.00") +
      "</span>" +
      "</div>" +
      "</label>";

    pairedItems.forEach(function (p, idx) {
      itemsHtml +=
        '<span class="pdp-ritual-plus" aria-hidden="true">+</span>' +
        '<label class="pdp-ritual-item is-checked" data-product-id="' +
        attrEsc(p.id) +
        '">' +
        '<input type="checkbox" class="pdp-ritual-checkbox" checked aria-label="Include ' +
        attrEsc(p.name) +
        '" data-price="' +
        (typeof p.price === "number" ? p.price.toFixed(2) : "0.00") +
        '">' +
        '<div class="pdp-ritual-item-thumb"><img src="' +
        attrEsc(p.image || "") +
        '" alt="" width="44" height="44" loading="lazy"></div>' +
        '<div class="pdp-ritual-item-details">' +
        '<span class="pdp-ritual-item-tag">Pairing ' +
        (idx + 1) +
        "</span>" +
        '<span class="pdp-ritual-item-name">' +
        attrEsc(p.name) +
        "</span>" +
        '<span class="pdp-ritual-item-price">$' +
        (typeof p.price === "number" ? p.price.toFixed(2) : "0.00") +
        "</span>" +
        "</div>" +
        "</label>";
    });

    var unlocksFreeShipping = total >= 40;
    var title = product.ritualTitle || "Complete the Ritual";

    return (
      '<div class="pdp-ritual-section pdp-ritual-compact" id="modalRitualSection">' +
      '<div class="pdp-ritual-header">' +
      '<span class="eyebrow">✦ COMPLETE THE RITUAL ✦</span>' +
      '<h4 class="pdp-ritual-title">✦ Complete the Ritual: ' +
      attrEsc(title) +
      " ✦</h4>" +
      "</div>" +
      '<div class="pdp-ritual-card">' +
      '<div class="pdp-ritual-items-grid">' +
      itemsHtml +
      "</div>" +
      '<div class="pdp-ritual-footer">' +
      '<div class="pdp-ritual-total-wrap">' +
      '<span class="pdp-ritual-total-label">Bundle:</span>' +
      '<span class="pdp-ritual-total-price" id="pdpRitualTotalPrice">$' +
      total.toFixed(2) +
      "</span>" +
      '<span class="pdp-ritual-shipping-badge" id="pdpRitualShippingBadge"' +
      (unlocksFreeShipping ? "" : ' hidden=""') +
      ">✓ Unlocks Free Tracked Shipping!</span>" +
      "</div>" +
      '<button type="button" class="btn btn-primary btn-sm pdp-ritual-add-btn" id="pdpRitualAddBtn" data-ritual-ids="' +
      attrEsc(allIds) +
      '">' +
      '<svg class="yl-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>' +
      '<span>Add All to Cart · <span class="ritual-btn-price">$' +
      total.toFixed(2) +
      "</span></span>" +
      "</button>" +
      "</div>" +
      "</div>" +
      "</div>"
    );
  }

  /**
   * Initializes PDP and modal ritual sections, dynamic bundle pricing, and 1-click add to cart.
   */
  function initPdpRitualSection(containerEl) {
    if (typeof document === "undefined") return;
    var section = containerEl || document.getElementById("pdpRitualSection");
    if (!section) return;

    var checkboxes = section.querySelectorAll(".pdp-ritual-checkbox");
    var totalPriceEl =
      section.querySelector("#pdpRitualTotalPrice") ||
      section.querySelector(".pdp-ritual-total-price");
    var btnPriceEl = section.querySelector(".ritual-btn-price");
    var addBtn =
      section.querySelector("#pdpRitualAddBtn") || section.querySelector(".pdp-ritual-add-btn");
    var shippingBadge =
      section.querySelector("#pdpRitualShippingBadge") ||
      section.querySelector(".pdp-ritual-shipping-badge");

    function updateTotals() {
      var sum = 0;
      var count = 0;
      var totalAvailable = checkboxes.length;
      checkboxes.forEach(function (cb) {
        if (cb.checked) {
          sum += parseFloat(cb.getAttribute("data-price")) || 0;
          count++;
          var label = cb.closest(".pdp-ritual-item");
          if (label) label.classList.add("is-checked");
        } else {
          var labelUnchecked = cb.closest(".pdp-ritual-item");
          if (labelUnchecked) labelUnchecked.classList.remove("is-checked");
        }
      });

      if (totalPriceEl) totalPriceEl.textContent = "$" + sum.toFixed(2);
      if (btnPriceEl) btnPriceEl.textContent = "$" + sum.toFixed(2);

      if (addBtn) {
        var iconSvg =
          '<svg class="yl-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>';
        if (count === totalAvailable) {
          addBtn.innerHTML =
            iconSvg +
            '<span>Add All to Cart · <span class="ritual-btn-price">$' +
            sum.toFixed(2) +
            "</span></span>";
        } else if (count > 1) {
          addBtn.innerHTML =
            iconSvg +
            "<span>Add Selected (" +
            count +
            ') to Cart · <span class="ritual-btn-price">$' +
            sum.toFixed(2) +
            "</span></span>";
        } else if (count === 1) {
          addBtn.innerHTML =
            iconSvg +
            '<span>Add Item to Cart · <span class="ritual-btn-price">$' +
            sum.toFixed(2) +
            "</span></span>";
        } else {
          addBtn.innerHTML =
            iconSvg + '<span>Select Items · <span class="ritual-btn-price">$0.00</span></span>';
        }
        addBtn.disabled = count === 0;
      }

      if (shippingBadge) {
        if (sum >= 40) {
          shippingBadge.hidden = false;
          shippingBadge.removeAttribute("hidden");
        } else {
          shippingBadge.hidden = true;
          shippingBadge.setAttribute("hidden", "");
        }
      }
    }

    checkboxes.forEach(function (cb) {
      cb.addEventListener("change", updateTotals);
    });

    if (addBtn) {
      addBtn.addEventListener("click", function () {
        var itemsToAdd = [];
        var pMap = getProductMap();
        checkboxes.forEach(function (cb) {
          if (cb.checked) {
            var itemLabel = cb.closest(".pdp-ritual-item");
            var prodId = itemLabel ? itemLabel.getAttribute("data-product-id") : null;
            if (!prodId && cb.hasAttribute("data-product-id")) {
              prodId = cb.getAttribute("data-product-id");
            }
            var product = pMap ? pMap.get(prodId) : null;
            if (
              !product &&
              window.YL_SEARCH_INDEX &&
              Array.isArray(window.YL_SEARCH_INDEX.products)
            ) {
              product = window.YL_SEARCH_INDEX.products.find(function (p) {
                return p && p.id === prodId;
              });
            }
            if (product) {
              itemsToAdd.push({
                id: product.id,
                name: product.name,
                price: product.price,
                image: product.image,
                category: product.category,
                qty: 1
              });
            }
          }
        });

        if (itemsToAdd.length) {
          if (window.YLCart && typeof window.YLCart.addItems === "function") {
            window.YLCart.addItems(itemsToAdd);
          } else if (window.YLCart && typeof window.YLCart.addItem === "function") {
            itemsToAdd.forEach(function (item) {
              window.YLCart.addItem(item);
            });
          }
        }
      });
    }

    updateTotals();
  }

  /**
   * Initializes Mobile Sticky Add-to-Cart Bottom Bar on PDPs (R1).
   * Observes primary purchase CTA container via IntersectionObserver to toggle sticky bar visibility,
   * provides two-way variant selection and price synchronization, and interfaces with cart.js.
   */
  function initPdpStickyBar() {
    if (typeof document === "undefined") return;
    var stickyBar = document.getElementById("pdpStickyBar");
    if (!stickyBar) return;

    var primaryCta =
      document.querySelector(".pdp-actions") ||
      document.querySelector(".pdp-cta-btn") ||
      document.querySelector(".pdp-details");

    if (primaryCta && typeof IntersectionObserver !== "undefined") {
      var observer = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            var isMobile = typeof window !== "undefined" ? window.innerWidth < 768 : true;
            var hasScrolledPast = !entry.isIntersecting && entry.boundingClientRect.top < 0;
            if (hasScrolledPast && isMobile) {
              stickyBar.classList.add("is-visible");
              stickyBar.setAttribute("aria-hidden", "false");
            } else {
              stickyBar.classList.remove("is-visible");
              stickyBar.setAttribute("aria-hidden", "true");
            }
          });
        },
        { threshold: 0 }
      );
      observer.observe(primaryCta);
    }

    var stickySelect = stickyBar.querySelector(".pdp-sticky-variant-select");
    var mainSelect = document.querySelector(".pdp-details .variant-select");
    var stickyPrice = stickyBar.querySelector(".pdp-sticky-price");
    var mainPrice =
      document.querySelector(".pdp-details .pdp-price") ||
      document.querySelector(".pdp-price-row .price");
    var stickyAddBtn = stickyBar.querySelector(".pdp-sticky-add-btn");
    var mainAddBtn =
      document.querySelector(".pdp-details .yl-add-item") ||
      document.querySelector(".pdp-actions .yl-add-item");

    function syncVariant(selectedOpt, selectEl, targetSelect) {
      if (!selectedOpt) return;
      var val = selectedOpt.value;
      var delta = parseFloat(selectedOpt.getAttribute("data-delta")) || 0;
      var basePrice = parseFloat(selectEl.getAttribute("data-base-price")) || 0;
      var newPrice = basePrice + delta;
      var formattedPrice = "$" + newPrice.toFixed(2);

      if (targetSelect && targetSelect.value !== val) {
        targetSelect.value = val;
      }
      if (stickyPrice) stickyPrice.textContent = formattedPrice;
      if (mainPrice) {
        var priceVal = mainPrice.querySelector('[itemprop="price"]');
        if (priceVal) {
          priceVal.textContent = newPrice.toFixed(2);
          priceVal.setAttribute("content", newPrice.toFixed(2));
        } else {
          mainPrice.textContent = formattedPrice;
        }
      }
      if (stickyAddBtn && stickyAddBtn.classList.contains("yl-add-item")) {
        stickyAddBtn.setAttribute("data-item-custom1-value", val);
        stickyAddBtn.setAttribute("data-item-price", newPrice.toFixed(2));
      }
      if (mainAddBtn && mainAddBtn.classList.contains("yl-add-item")) {
        mainAddBtn.setAttribute("data-item-custom1-value", val);
        mainAddBtn.setAttribute("data-item-price", newPrice.toFixed(2));
      }
    }

    if (stickySelect) {
      stickySelect.addEventListener("change", function () {
        var opt = stickySelect.options[stickySelect.selectedIndex];
        syncVariant(opt, stickySelect, mainSelect);
      });
    }

    if (mainSelect) {
      mainSelect.addEventListener("change", function () {
        var opt = mainSelect.options[mainSelect.selectedIndex];
        syncVariant(opt, mainSelect, stickySelect);
      });
    }
  }

  initRecentlyViewed();
  initPdpRitualSection();
  initPdpStickyBar();
  initHoverPrefetch();

  /* ---------- Load translator ---------- */
  (function () {
    if (typeof document === "undefined") return;
    var s = document.createElement("script");
    s.src = "/assets/js/translator.js?v=2.0";
    s.defer = true;
    document.body.appendChild(s);
  })();

  /* ---------- Node.js / Unit Test Export ---------- */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      getWishlist: getWishlist,
      saveWishlist: saveWishlist,
      attrEsc: attrEsc,
      safeUrl: safeUrl,
      safeLinkUrl: safeLinkUrl,
      renderMarkdown: renderMarkdown,
      addToCartHTML: addToCartHTML,
      variantSelectHTML: variantSelectHTML,
      stockBadgeHTML: stockBadgeHTML,
      priceHTML: priceHTML,
      applyTheme: applyTheme,
      pickFeatured: pickFeatured,
      pickNextEvent: pickNextEvent,
      toggleWish: toggleWish,
      isWished: isWished,
      currentTheme: currentTheme,
      renderWishDrawer: renderWishDrawer,
      getEventDateParts: getEventDateParts,
      getNextDayStr: getNextDayStr,
      getCalendarDates: getCalendarDates,
      generateGoogleCalendarUrl: generateGoogleCalendarUrl,
      escapeIcsText: escapeIcsText,
      generateIcsContent: generateIcsContent,
      generateIcsDataUri: generateIcsDataUri,
      getEventIcsFilename: getEventIcsFilename,
      formatEventMapDestination: formatEventMapDestination,
      generateGoogleMapsDirUrl: generateGoogleMapsDirUrl,
      generateAppleMapsDirUrl: generateAppleMapsDirUrl,
      parsePickupMarketParam: parsePickupMarketParam,
      handlePickupMarketDeepLink: handlePickupMarketDeepLink,
      eventCardHTML: eventCardHTML,
      getReadingTime: getReadingTime,
      renderClockIconSvg: renderClockIconSvg,
      renderJournalTagsHtml: renderJournalTagsHtml,
      findFeaturedProduct: findFeaturedProduct,
      renderFeaturedProductCardHtml: renderFeaturedProductCardHtml,
      formatReviewDate: formatReviewDate,
      filterReviews: filterReviews,
      renderReviewCardHtml: renderReviewCardHtml,
      parseOrderStatusQuery: parseOrderStatusQuery,
      maskEmail: maskEmail,
      initOrderStatusPage: initOrderStatusPage,
      initOrderStatusModal: initOrderStatusModal,
      orderStatusFallbackHTML: orderStatusFallbackHTML,
      siteFlagEnabled: siteFlagEnabled,
      searchGlobal: searchGlobal,
      tokenizeQuery: tokenizeQuery,
      expandTokensWithSynonyms: expandTokensWithSynonyms,
      getSearchIndex: getSearchIndex,
      formatVariantChipLabel: formatVariantChipLabel,
      renderVariantChipsHtml: renderVariantChipsHtml,
      initGlobalSearchModal: initGlobalSearchModal,
      initHoverPrefetch: initHoverPrefetch,
      getRecentlyViewed: getRecentlyViewed,
      recordRecentlyViewed: recordRecentlyViewed,
      renderRecentlyViewedCarousel: renderRecentlyViewedCarousel,
      initRecentlyViewed: initRecentlyViewed,
      renderModalRitualHtml: renderModalRitualHtml,
      initPdpRitualSection: initPdpRitualSection,
      initPdpStickyBar: initPdpStickyBar,
      _resetState: function () {
        wishCache = null;
        wishSet = null;
        cachedTheme = null;
        productMapCache = null;
        searchIndexCache = null;
        recentlyViewedCache = null;
      }
    };
  }
})();
