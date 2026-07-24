/* ==========================================================
   Y'ALLTERNATIVE LIVING | on-site cart -> Stripe Checkout
   Zero dependencies, vanilla JS. Self-contained on-site cart +
   drawer that hands off to Stripe Checkout via the Cloudflare
   Worker in workers/checkout.js. Self-initializes on load (see
   the bottom of this file) -- just include this script on a page,
   nothing else to wire up.

   The cart reads the same data-item-* attributes the Add to Cart
   buttons already carry (a holdover naming convention from the
   Snipcart era this replaced -- see docs/STRIPE-MIGRATION.md),
   so the button markup didn't have to change for the cart to work.
   ========================================================== */
/* global module */
(function (root) {
  "use strict";

  var STORAGE_KEY = "yl-cart-v1";
  var CHECKOUT_URL = "/api/checkout"; // Cloudflare Worker route (workers/checkout.js)
  var DEFAULT_FREE_SHIP = 40; // products.json shop.freeShippingThreshold
  var MAX_QTY = 99;
  var GIFT_CARD_ID = "yallternative-gift-card";

  /* ---------------- Pure cart math (unit-testable in Node) ---------------- */

  // A line's identity = product id + chosen variant label, so "Tank Top / M"
  // and "Tank Top / L" are separate lines that merge/add independently.
  //
  // Gift cards are the one exception: two gift cards at the same dollar
  // amount must NOT merge into one qty-2 line, because each one can carry a
  // different recipient email/sender/message. item.lineId (assigned once,
  // at add-time, see newLineId() below) keeps every gift card its own line
  // regardless of amount.
  function lineKey(item) {
    if (item.id === GIFT_CARD_ID) {
      return item.id + "|" + (item.lineId || item.variantLabel || "");
    }
    return item.id + "|" + (item.variantLabel || "");
  }

  // Parse Snipcart-style custom-field options ("M[+0.00]|L[+2.00]") and return
  // the price delta for a chosen label. Keeps the cart reading the exact same
  // attribute the buttons already emit.
  function deltaForLabel(optionsStr, label) {
    if (!optionsStr || !label) return 0;
    var parts = optionsStr.split("|");
    for (var i = 0; i < parts.length; i++) {
      var m = parts[i].match(/^(.*)\[([+-])([0-9.]+)\]$/);
      if (m && m[1] === label) {
        var val = parseFloat(m[3]) || 0;
        return m[2] === "-" ? -val : val;
      }
    }
    return 0;
  }

  // cap: an optional per-product ceiling (from data-item-max-quantity, a
  // real stock count -- see main.js's addToCartHTML()), always additionally
  // bounded by the cart's own hard MAX_QTY.
  function clampQty(n, cap) {
    var q = parseInt(n, 10);
    if (isNaN(q) || q < 1) return 1;
    var ceiling = cap && cap > 0 ? Math.min(cap, MAX_QTY) : MAX_QTY;
    if (q > ceiling) return ceiling;
    return q;
  }

  function unitPrice(item) {
    return Math.max(0, (Number(item.price) || 0) + (Number(item.variantDelta) || 0));
  }

  function subtotal(items) {
    return (items || []).reduce(function (sum, it) {
      return sum + unitPrice(it) * it.qty;
    }, 0);
  }

  function totalCount(items) {
    return (items || []).reduce(function (n, it) {
      return n + it.qty;
    }, 0);
  }

  // Merge a new item into the list (same line -> bump qty, capped).
  function addToList(items, item) {
    var list = items.slice();
    var key = lineKey(item);
    var found = null;
    for (var i = 0; i < list.length; i++) {
      if (lineKey(list[i]) === key) {
        found = list[i];
        break;
      }
    }
    if (found) {
      found.qty = clampQty(found.qty + item.qty, item.maxQty || found.maxQty);
      // A later add can supply a fresher maxQty (e.g. stock was updated
      // between page loads); keep whichever is present.
      if (item.maxQty) found.maxQty = item.maxQty;
    } else {
      item.qty = clampQty(item.qty, item.maxQty);
      list.push(item);
    }
    return list;
  }

  // The exact payload shape workers/checkout.js validates. Gift-card lines
  // additionally carry recipient/sender/message so the Worker can attach
  // them to the Stripe session as metadata -- never as anything that
  // affects price (price for gift cards is derived server-side from the
  // "Preset $NN" variant label alone, see workers/checkout.js).
  function toCheckoutPayload(items, pickupMarket) {
    var payload = {
      items: (items || []).map(function (it) {
        var o = { id: it.id, qty: it.qty };
        if (it.variantLabel) o.variant = it.variantLabel;
        if (it.id === GIFT_CARD_ID) {
          if (it.giftRecipientEmail) o.giftRecipientEmail = it.giftRecipientEmail;
          if (it.giftSenderName) o.giftSenderName = it.giftSenderName;
          if (it.giftMessage) o.giftMessage = it.giftMessage;
        }
        return o;
      })
    };
    if (pickupMarket) {
      payload.pickupMarket = pickupMarket;
    }
    return payload;
  }

  // Expose the pure helpers to Node for testing without touching the DOM layer.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      lineKey: lineKey,
      deltaForLabel: deltaForLabel,
      clampQty: clampQty,
      unitPrice: unitPrice,
      subtotal: subtotal,
      totalCount: totalCount,
      addToList: addToList,
      toCheckoutPayload: toCheckoutPayload
    };
  }

  // Everything below needs a browser; bail cleanly under Node (tests).
  if (typeof document === "undefined") return;

  /* ---------------- State + persistence ---------------- */

  var state = { items: [] };

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      state.items = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      state.items = [];
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.items));
    } catch (e) {
      /* storage full / blocked -- cart still works for this page view */
    }
  }

  function money(n) {
    return "$" + (Math.round(n * 100) / 100).toFixed(2);
  }

  // Unique-enough id for a single gift-card line (see lineKey() above) --
  // doesn't need to be cryptographically random, just distinct per add.
  function newLineId() {
    if (root.crypto && typeof root.crypto.randomUUID === "function") {
      return root.crypto.randomUUID();
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function freeShipThreshold() {
    var v = Number(root.YL_FREE_SHIP);
    return v > 0 ? v : DEFAULT_FREE_SHIP;
  }

  /* ---------------- Drawer UI ---------------- */

  var drawer, itemsEl, footEl, liveEl;

  function ensureDrawer() {
    if (drawer) return;
    drawer = document.createElement("div");
    drawer.id = "yl-cart-drawer";
    drawer.className = "yl-cart-drawer";
    drawer.setAttribute("popover", "auto");
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-label", "Your cart");
    drawer.innerHTML =
      '<div class="yl-cart-head">' +
      "<h2>Your Cart</h2>" +
      '<button type="button" class="yl-cart-close" aria-label="Close cart">&times;</button>' +
      "</div>" +
      '<div class="yl-cart-items" id="yl-cart-items"></div>' +
      '<div class="yl-cart-foot" id="yl-cart-foot"></div>';
    document.body.appendChild(drawer);
    itemsEl = drawer.querySelector("#yl-cart-items");
    footEl = drawer.querySelector("#yl-cart-foot");

    drawer.querySelector(".yl-cart-close").addEventListener("click", closeDrawer);

    // Event delegation for qty +/- and remove.
    itemsEl.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-cart-action]");
      if (!btn) return;
      var key = btn.getAttribute("data-key");
      var action = btn.getAttribute("data-cart-action");
      if (action === "inc") changeQty(key, 1);
      else if (action === "dec") changeQty(key, -1);
      else if (action === "remove") removeLine(key);
    });

    // aria-live region for screen-reader cart announcements.
    liveEl = document.createElement("div");
    liveEl.className = "sr-only";
    liveEl.setAttribute("aria-live", "polite");
    document.body.appendChild(liveEl);
  }

  function openDrawer() {
    ensureDrawer();
    render();
    if (typeof drawer.showPopover === "function") {
      try {
        drawer.showPopover();
      } catch (e) {
        drawer.setAttribute("data-open", "true");
      }
    } else {
      drawer.setAttribute("data-open", "true");
    }
  }

  function closeDrawer() {
    if (!drawer) return;
    if (typeof drawer.hidePopover === "function") {
      try {
        drawer.hidePopover();
      } catch (e) {
        drawer.removeAttribute("data-open");
      }
    } else {
      drawer.removeAttribute("data-open");
    }
  }

  function physicalSubtotal(items) {
    return (items || []).reduce(function (sum, it) {
      if (it.id === GIFT_CARD_ID) return sum;
      return sum + unitPrice(it) * it.qty;
    }, 0);
  }

  function getLoyaltyConfig() {
    var site = (root.YL_CONTENT && root.YL_CONTENT.site) || {};
    return {
      name: site.loyaltyPointsName || "Alt-Points",
      singular: site.loyaltyPointsSingular || "Alt-Point",
      rate: Number(site.loyaltyPointsPerDollar) > 0 ? Number(site.loyaltyPointsPerDollar) : 1,
      emoji: site.loyaltyBadgeEmoji || "✨",
      enabled: site.enableLoyaltyPoints !== false
    };
  }

  function render() {
    ensureDrawer();
    if (!state.items.length) {
      itemsEl.innerHTML = '<p class="yl-cart-empty">Your cart is empty.</p>';
      footEl.innerHTML = "";
      updateBadges();
      return;
    }

    itemsEl.innerHTML = state.items
      .map(function (it) {
        var key = lineKey(it);
        var line = unitPrice(it) * it.qty;
        var variantText = it.variantLabel ? " (" + escapeHtml(it.variantLabel) + ")" : "";
        return (
          '<div class="yl-cart-line yl-cart-item">' +
          '<img src="' +
          escapeAttr(it.image || "") +
          '" alt="" width="48" height="48" loading="lazy">' +
          '<div class="yl-cart-details">' +
          "<strong>" +
          escapeHtml(it.name) +
          variantText +
          "</strong>" +
          "<span>" +
          money(unitPrice(it)) +
          "</span>" +
          "</div>" +
          '<div class="yl-cart-qty">' +
          '<button type="button" data-cart-action="dec" data-key="' +
          escapeAttr(key) +
          '" aria-label="Decrease quantity">-</button>' +
          "<span>" +
          it.qty +
          "</span>" +
          '<button type="button" data-cart-action="inc" data-key="' +
          escapeAttr(key) +
          '" aria-label="Increase quantity"' +
          (it.maxQty && it.qty >= it.maxQty ? " disabled" : "") +
          ">+</button>" +
          "</div>" +
          '<span class="yl-cart-line-total">' +
          money(line) +
          "</span>" +
          '<button type="button" class="yl-cart-remove" data-cart-action="remove" data-key="' +
          escapeAttr(key) +
          '" aria-label="Remove item">&times;</button>' +
          "</div>"
        );
      })
      .join("");

    var sub = subtotal(state.items);
    var physSub = physicalSubtotal(state.items);
    var threshold = freeShipThreshold();
    var remaining = Math.max(0, threshold - physSub);

    var shipMsg = state.isPickup
      ? "📍 Local SC Market Pick-up Selected ($0 Shipping)"
      : remaining > 0
        ? "Add " + money(remaining) + " for free shipping"
        : "You've unlocked free shipping!";
    var pct = state.isPickup ? 100 : Math.min(100, Math.round((physSub / threshold) * 100));

    var loyalty = getLoyaltyConfig();
    var earnedPoints = Math.floor(sub * loyalty.rate);
    var pointsMsg =
      earnedPoints > 0
        ? 'You\'ll earn <strong id="cart-points-count">' +
          earnedPoints +
          "</strong> " +
          (earnedPoints === 1 ? escapeHtml(loyalty.singular) : escapeHtml(loyalty.name)) +
          " with this order!"
        : "Add items to earn " +
          escapeHtml(loyalty.name) +
          " ($1 = " +
          loyalty.rate +
          " point" +
          (loyalty.rate === 1 ? "" : "s") +
          ")!";
    var pointsHTML = loyalty.enabled
      ? '<div class="yl-cart-points" style="font-size:0.85rem; color:var(--whiskey); margin-bottom:8px; text-align:center; font-weight:600;">' +
        escapeHtml(loyalty.emoji) +
        ' <span id="cart-points-banner">' +
        pointsMsg +
        "</span></div>"
      : "";

    var pickupHTML = "";
    if (
      !root.YL_CONTENT ||
      !root.YL_CONTENT.site ||
      root.YL_CONTENT.site.enableLocalPickup !== false
    ) {
      var upcomingEvts =
        root.YL_EVENTS && Array.isArray(root.YL_EVENTS.upcoming) ? root.YL_EVENTS.upcoming : [];
      var optionsHTML = upcomingEvts
        .map(function (evt) {
          var label =
            (evt.name || "Pop-up Market") +
            " — " +
            (evt.dateLabel || "") +
            " (" +
            (evt.location || "Landrum, SC") +
            ")";
          return (
            '<option value="' +
            escapeAttr(label) +
            '"' +
            (state.pickupMarket === label ? " selected" : "") +
            ">" +
            escapeHtml(label) +
            "</option>"
          );
        })
        .join("");

      if (!optionsHTML) {
        optionsHTML =
          '<option value="Landrum SC Farmers Market (Saturdays 9am-12pm)">Landrum SC Farmers Market (Saturdays 9am-12pm)</option>';
      }

      if (!state.pickupMarket && upcomingEvts[0]) {
        var defaultEvt = upcomingEvts[0];
        state.pickupMarket =
          (defaultEvt.name || "Pop-up Market") +
          " — " +
          (defaultEvt.dateLabel || "") +
          " (" +
          (defaultEvt.location || "Landrum, SC") +
          ")";
      }

      pickupHTML =
        '<div class="yl-cart-pickup-wrap" style="margin: 10px 0; padding: 10px; background: var(--paper-dim); border: 1px solid var(--border-color); border-radius: var(--radius-sm); font-size: 0.85rem;">' +
        '  <label style="display: flex; align-items: center; gap: 8px; font-weight: 600; cursor: pointer; color: var(--whiskey); margin: 0;">' +
        '    <input type="checkbox" id="yl-cart-pickup-checkbox" style="accent-color: var(--whiskey); cursor: pointer;"' +
        (state.isPickup ? " checked" : "") +
        ">" +
        "    <span>📍 Local SC Market Pick-up (Free)</span>" +
        "  </label>" +
        '  <div id="yl-cart-pickup-select-container" style="margin-top: 8px;' +
        (state.isPickup ? " display: block;" : " display: none;") +
        '">' +
        '    <label for="yl-cart-pickup-select" style="font-size: 0.78rem; color: var(--paper-muted); display: block; margin-bottom: 4px;">Choose Upcoming Market Location:</label>' +
        '    <select id="yl-cart-pickup-select" style="width: 100%; padding: 6px 8px; font-size: 0.82rem; background: var(--paper); color: var(--paper-bright); border: 1px solid var(--border-color); border-radius: 4px;">' +
        optionsHTML +
        "    </select>" +
        "  </div>" +
        "</div>";
    }

    footEl.innerHTML =
      upsellHTML() +
      pointsHTML +
      pickupHTML +
      '<div class="yl-cart-ship">' +
      '<div class="yl-cart-ship-msg">' +
      shipMsg +
      "</div>" +
      '<div class="yl-cart-ship-bar"><span style="width:' +
      pct +
      '%"></span></div>' +
      "</div>" +
      '<div class="yl-cart-subtotal"><span>Subtotal</span><strong>' +
      money(sub) +
      "</strong></div>" +
      '<button type="button" class="btn btn-primary btn-block yl-cart-checkout">Checkout</button>' +
      '<p class="yl-cart-note">Promo codes, gift cards &amp; taxes applied at checkout.</p>';

    footEl.querySelector(".yl-cart-checkout").addEventListener("click", checkout);

    var pickupCb = footEl.querySelector("#yl-cart-pickup-checkbox");
    var pickupSelect = footEl.querySelector("#yl-cart-pickup-select");
    var pickupContainer = footEl.querySelector("#yl-cart-pickup-select-container");

    if (pickupCb) {
      pickupCb.addEventListener("change", function () {
        state.isPickup = pickupCb.checked;
        if (pickupContainer) {
          pickupContainer.style.display = state.isPickup ? "block" : "none";
        }
        if (pickupSelect) {
          state.pickupMarket = pickupSelect.value;
        }
        render();
      });
    }

    if (pickupSelect) {
      pickupSelect.addEventListener("change", function () {
        state.pickupMarket = pickupSelect.value;
      });
    }

    var upsellRow = footEl.querySelector(".yl-cart-upsell");
    if (upsellRow) {
      upsellRow.addEventListener("click", function (e) {
        var b = e.target.closest("[data-upsell-add]");
        if (!b) return;
        addUpsell(b.getAttribute("data-upsell-add"));
      });
    }
    updateBadges();
  }

  /* ---------------- Upsell suggestions ----------------
     Best-practice cart-drawer lever: 2-3 relevant, one-click, variant-free
     suggestions typically add 5-10% to AOV. We only ever suggest real,
     in-stock products (from window.YL_PRODUCTS) that have no variant to
     pick (so "add" is truly one click) and aren't already in the cart. */
  function upsellCandidates() {
    var catalog =
      root.YL_PRODUCTS && Array.isArray(root.YL_PRODUCTS.products) ? root.YL_PRODUCTS.products : [];
    var inCart = {};
    state.items.forEach(function (it) {
      inCart[it.id] = true;
    });
    return catalog
      .filter(function (p) {
        var hasVariant = p.variants && p.variants.options && p.variants.options.length;
        var soldOut = p.stock === 0 || p.comingSoon;
        return !hasVariant && !soldOut && !inCart[p.id] && p.id !== "yallternative-gift-card";
      })
      .slice(0, 3);
  }

  function upsellHTML() {
    var picks = upsellCandidates();
    if (!picks.length) return "";
    var cards = picks
      .map(function (p) {
        return (
          '<button type="button" class="yl-cart-upsell-item" data-upsell-add="' +
          escapeAttr(p.id) +
          '">' +
          '<img src="' +
          escapeAttr(p.image || "") +
          '" alt="" width="40" height="40" loading="lazy">' +
          '<span class="yl-cart-upsell-name">' +
          escapeHtml(p.name) +
          "</span>" +
          '<span class="yl-cart-upsell-add">Add ' +
          money(Number(p.price) || 0) +
          "</span>" +
          "</button>"
        );
      })
      .join("");
    return (
      '<div class="yl-cart-upsell"><p class="yl-cart-upsell-title">You might also like</p>' +
      cards +
      "</div>"
    );
  }

  function addUpsell(id) {
    var catalog =
      root.YL_PRODUCTS && Array.isArray(root.YL_PRODUCTS.products) ? root.YL_PRODUCTS.products : [];
    var p = catalog.find(function (x) {
      return x.id === id;
    });
    if (!p) return;
    state.items = addToList(state.items, {
      id: p.id,
      name: p.name,
      price: Number(p.price) || 0,
      image: p.image || "",
      variantName: "",
      variantLabel: "",
      variantDelta: 0,
      qty: 1
    });
    save();
    render();
    announce(p.name + " added to cart");
  }

  /* ---------------- Cart operations ---------------- */

  function addItemFromButton(btn) {
    var d = btn.dataset;
    var variantLabel = d.itemCustom1Value || "";
    var variantName = d.itemCustom1Name || "";
    var variantDelta = deltaForLabel(d.itemCustom1Options, variantLabel);
    var parsedMax = parseInt(d.itemMaxQuantity, 10);
    var item = {
      id: d.itemId,
      name: d.itemName,
      price: parseFloat(d.itemPrice) || 0,
      image: d.itemImage || "",
      variantName: variantName,
      variantLabel: variantLabel,
      variantDelta: variantDelta,
      maxQty: !isNaN(parsedMax) && parsedMax > 0 ? parsedMax : null,
      qty: 1
    };
    if (d.itemId === GIFT_CARD_ID) {
      // Every gift-card add is its own line (see lineKey()); capture the
      // recipient/sender/message fields gift-card.js keeps in sync on the
      // button so they travel through to Stripe as metadata at checkout.
      item.lineId = newLineId();
      item.giftRecipientEmail = d.itemCustom2Value || "";
      item.giftSenderName = d.itemCustom3Value || "";
      item.giftMessage = d.itemCustom4Value || "";
    }
    state.items = addToList(state.items, item);
    save();
    render();
    openDrawer();
    announce(item.name + " added to cart");
  }

  function changeQty(key, delta) {
    for (var i = 0; i < state.items.length; i++) {
      if (lineKey(state.items[i]) === key) {
        var next = state.items[i].qty + delta;
        if (next < 1) {
          state.items.splice(i, 1);
        } else {
          state.items[i].qty = clampQty(next, state.items[i].maxQty);
        }
        break;
      }
    }
    save();
    render();
  }

  function removeLine(key) {
    state.items = state.items.filter(function (it) {
      return lineKey(it) !== key;
    });
    save();
    render();
  }

  function checkout() {
    if (!state.items.length) return;
    var btn = footEl.querySelector(".yl-cart-checkout");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Redirecting…";
    }
    fetch(CHECKOUT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        toCheckoutPayload(state.items, state.isPickup ? state.pickupMarket : null)
      )
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (data && data.url) {
          window.location = data.url;
        } else {
          throw new Error((data && data.error) || "Checkout unavailable");
        }
      })
      .catch(function (err) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Checkout";
        }
        announce("Checkout error: " + err.message);
        window.alert("Sorry -- checkout isn't available right now. Please try again in a moment.");
      });
  }

  function clear() {
    state.items = [];
    save();
    render();
  }

  /* ---------------- Badges + helpers ---------------- */

  function updateBadges() {
    var count = totalCount(state.items);
    var badges = document.querySelectorAll(".cart-toggle .badge, [data-cart-count]");
    badges.forEach(function (b) {
      b.textContent = count > 0 ? String(count) : "";
    });
  }

  function announce(msg) {
    if (liveEl) liveEl.textContent = msg;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  /* ---------------- Init / wiring ---------------- */

  var initialized = false;
  function init(opts) {
    opts = opts || {};
    if (initialized && !opts.force) return;
    initialized = true;
    load();
    ensureDrawer();
    updateBadges();

    // Add to Cart (buttons keep their existing classes/attributes --
    // .yl-add-item is a holdover name for "the add-to-cart button class,"
    // not a reference to any particular cart backend).
    document.addEventListener("click", function (e) {
      var addBtn = e.target.closest(".yl-add-item, [data-yl-add]");
      if (addBtn) {
        e.preventDefault();
        addItemFromButton(addBtn);
        return;
      }
      // Cart icon in the nav opens our drawer.
      var toggle = e.target.closest(".cart-toggle, [data-yl-cart-open]");
      if (toggle) {
        e.preventDefault();
        openDrawer();
      }
    });

    // Cross-tab sync: when the cart changes in another tab, this tab's
    // localStorage fires a `storage` event -- reload state and re-render so
    // the badge/drawer never show stale counts across tabs.
    window.addEventListener("storage", function (e) {
      if (e.key === STORAGE_KEY) {
        load();
        render();
        updateBadges();
      }
    });
  }

  root.YLCart = {
    init: init,
    open: openDrawer,
    close: closeDrawer,
    clear: clear,
    count: function () {
      return totalCount(state.items);
    },
    items: function () {
      return state.items.slice();
    }
  };

  // Self-initialize: including this script on a page is the only setup
  // required. Runs after DOM parsing (this script is loaded with `defer`,
  // so DOMContentLoaded may already have fired by the time we get here).
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      init();
    });
  } else {
    init();
  }
})(typeof window !== "undefined" ? window : this);
