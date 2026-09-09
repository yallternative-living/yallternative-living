/* ==========================================================
   Y'ALLTERNATIVE LIVING | orders.html page logic
   Loaded `defer`, after main.js and cart.js (both also deferred, so
   window.YLCart and window.YL_PRODUCTS exist by the time this runs).

   No accounts, no passwords. Two states on one page:
     1. No token in the URL: an email form. It POSTs the address to
        /api/orders/request-link and shows the SAME confirmation whatever
        the Worker knew about that address -- the page never says "we have
        orders for you" or "we don't", because that would make the form a
        way to test whether an address has shopped here.
     2. ?token= in the URL (from the emailed link): the token is read, then
        scrubbed from the address bar before anything else happens, and
        GET /api/orders?token= paints the list -- date, items with
        quantities and unit prices, total, status, a tracking link when
        the parcel has one, a Reorder button, and the points balance when
        the loyalty switch is on. The token works once; a refresh shows
        the form again with a note saying why.

   NOTHING HERE MAY USE innerHTML WITH A SERVER STRING. Line names come
   from Stripe by way of the catalog and tracking links from metadata a
   human typed, so every value is set with textContent and the one href
   goes through safeLinkUrl (http(s) only). The page sends NO analytics
   event of its own; the pageview the tracker records drops the query
   string (data-exclude-search), and the token is gone from the URL
   before the page settles anyway.
   ========================================================== */
(function () {
  "use strict";

  var LINK_ENDPOINT = "/api/orders/request-link";
  var LIST_ENDPOINT = "/api/orders";
  var CONTACT_EMAIL = "y.allternative.living@gmail.com";

  /* Render a dictionary key through the translator (window.YL_T) with the
     English as the fallback -- the same helper cart.js uses. */
  function tr(key, vars, fallbackEn) {
    var t = typeof window !== "undefined" ? window.YL_T : null;
    if (typeof t !== "function") return fallbackEn;
    var out;
    try {
      out = t(key, vars || {});
    } catch (e) {
      return fallbackEn;
    }
    return typeof out === "string" && out && out !== key ? out : fallbackEn;
  }

  function siteFlagEnabled(name) {
    var site = (window.YL_CONTENT && window.YL_CONTENT.site) || {};
    return site[name] !== false;
  }

  /* "$25" for whole dollars, "$12.34" when there are cents -- the rule every
     price on the site follows; Intl for any other currency. */
  function money(cents, currency) {
    var value = Number(cents);
    if (!isFinite(value)) return "";
    var code = String(currency || "usd").toUpperCase();
    if (code === "USD") {
      var whole = Math.round(value);
      return whole % 100 === 0 ? "$" + whole / 100 : "$" + (whole / 100).toFixed(2);
    }
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(
        value / 100
      );
    } catch (e) {
      void e;
      return code + " " + (value / 100).toFixed(2);
    }
  }

  function placedOn(seconds) {
    var n = Number(seconds);
    if (!isFinite(n) || n <= 0) return "";
    var date = new Date(n * 1000);
    if (isNaN(date.getTime())) return "";
    try {
      return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    } catch (e) {
      void e;
      return date.toISOString().slice(0, 10);
    }
  }

  /* The same words order-status.html uses for the same metadata, so an order
     never reads "Shipped" on one page and something else on the other. */
  function statusWords(status) {
    var s = String(status || "")
      .trim()
      .toLowerCase();
    if (s === "shipped" || s === "fulfilled") return tr("orders.shipped", null, "Shipped");
    if (s === "delivered") return tr("orders.delivered", null, "Delivered");
    if (s === "refunded") return tr("orders.refunded", null, "Refunded");
    if (s === "cancelled" || s === "canceled") return tr("orders.cancelled", null, "Cancelled");
    return tr("orders.processing", null, "Paid, being packed");
  }

  /* http(s) only. A `javascript:` tracking link typed into Stripe metadata
     must never become a clickable href here. */
  function safeLinkUrl(value) {
    if (typeof value !== "string" || !value) return "";
    try {
      var url = new URL(value, window.location.href);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
    } catch (e) {
      void e;
      return "";
    }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function mailtoHref() {
    return (
      "mailto:" +
      CONTACT_EMAIL +
      "?subject=" +
      encodeURIComponent("My orders") +
      "&body=" +
      encodeURIComponent("Hi! I'd like to see my past orders. The email I ordered with is: ")
    );
  }

  /* ---------------------------------------------------------- the catalog */

  function catalogEntry(id) {
    var cat = window.YL_PRODUCTS || {};
    var lists = [cat.products, cat.bundles];
    for (var i = 0; i < lists.length; i++) {
      var list = Array.isArray(lists[i]) ? lists[i] : [];
      for (var j = 0; j < list.length; j++) {
        if (list[j] && list[j].id === id) return list[j];
      }
    }
    return null;
  }

  /**
   * Turns a past order's lines into what window.YLCart.addItems expects:
   * the live catalog entry (name, price, image, category), the option that
   * was bought (matched by label against the live option list, so a size
   * that no longer exists is dropped rather than added blind), and the
   * quantity. Lines the Worker marked non-reorderable -- gift cards, boxes,
   * gift sets with per-member choices -- are skipped and counted, so the
   * page can say so.
   *
   * @returns {{items: object[], skipped: number}}
   */
  function cartLinesFor(order) {
    var items = [];
    var skipped = 0;
    var lines = (order && order.items) || [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i] || {};
      var entry = line.reorderable && line.productId ? catalogEntry(line.productId) : null;
      if (!entry || entry.inStock === false) {
        skipped++;
        continue;
      }
      var cartLine = {
        id: entry.id,
        name: entry.name || line.name || entry.id,
        price: Number(entry.price) || 0,
        image: entry.image || "",
        category: entry.category || "",
        qty: Number(line.quantity) > 0 ? Math.round(Number(line.quantity)) : 1
      };
      if (typeof entry.stock === "number" && entry.stock > 0) cartLine.maxQty = entry.stock;
      var options =
        entry.variants && Array.isArray(entry.variants.options) ? entry.variants.options : null;
      if (options && options.length) {
        var wanted = String(line.variant || "").trim();
        var opt = null;
        for (var k = 0; k < options.length; k++) {
          var o = options[k] || {};
          if (o.label === wanted || o.name === wanted || o.id === wanted) {
            opt = o;
            break;
          }
        }
        if (!opt || opt.inStock === false || opt.soldOut === true) {
          skipped++;
          continue;
        }
        cartLine.variantName = entry.variants.name || entry.variants.label || "Option";
        cartLine.variantLabel = opt.label || wanted;
        cartLine.variantDelta = Number(opt.priceDelta) || 0;
      }
      items.push(cartLine);
    }
    return { items: items, skipped: skipped };
  }

  function reorder(order, statusEl) {
    var plan = cartLinesFor(order);
    if (!plan.items.length) {
      if (statusEl) {
        statusEl.textContent = tr(
          "orders.nothingToReorder",
          null,
          "Nothing from this order can go straight back in the cart -- gift cards, boxes and gift sets are picked fresh from the shop."
        );
      }
      return plan;
    }
    if (window.YLCart && typeof window.YLCart.addItems === "function") {
      window.YLCart.addItems(plan.items);
    }
    if (statusEl) {
      statusEl.textContent = plan.skipped
        ? tr(
            "orders.reorderedSome",
            { count: plan.items.length, skipped: plan.skipped },
            plan.items.length +
              " line(s) added to your cart. " +
              plan.skipped +
              " could not be re-added (sold out, changed, or picked fresh from the shop)."
          )
        : tr(
            "orders.reorderedAll",
            { count: plan.items.length },
            "Added to your cart. Same order, same good stuff."
          );
    }
    return plan;
  }

  /* ---------------------------------------------------------- rendering */

  function renderOrder(order) {
    var card = el("article", "orders-card");
    var head = el("div", "orders-card-head");
    var when = placedOn(order.placedAt);
    head.appendChild(
      el(
        "h3",
        "orders-card-title",
        when ? tr("orders.placedOn", { date: when }, "Placed " + when) : "Order"
      )
    );
    head.appendChild(el("span", "orders-status", statusWords(order.status)));
    card.appendChild(head);

    var items = Array.isArray(order.items) ? order.items : [];
    if (items.length) {
      var list = el("ul", "orders-items");
      for (var i = 0; i < items.length; i++) {
        var line = items[i] || {};
        var qty = Number(line.quantity) > 0 ? Math.round(Number(line.quantity)) : 1;
        var li = el("li", "orders-item");
        li.appendChild(
          el("span", "orders-item-name", String(line.name == null ? "Item" : line.name))
        );
        var unit = money(line.unitCents, order.currency);
        li.appendChild(
          el("span", "orders-item-qty", unit ? "× " + qty + " · " + unit + " each" : "× " + qty)
        );
        list.appendChild(li);
      }
      card.appendChild(list);
    } else {
      card.appendChild(
        el(
          "p",
          "muted",
          tr("orders.noLines", null, "The line items for this order are on its status page.")
        )
      );
    }

    var total = money(order.amountTotalCents, order.currency);
    if (total)
      card.appendChild(
        el("p", "orders-total", tr("orders.total", { total: total }, "Total: " + total))
      );

    var actions = el("div", "orders-actions");
    var track = safeLinkUrl(order.trackingUrl);
    if (track) {
      var a = el("a", "btn btn-primary btn-sm", tr("orders.track", null, "Track this shipment"));
      a.setAttribute("href", track);
      a.setAttribute("rel", "noopener noreferrer");
      a.setAttribute("target", "_blank");
      actions.appendChild(a);
    }
    var reorderBtn = el(
      "button",
      "btn btn-outline btn-sm orders-reorder-btn",
      tr("orders.reorder", null, "Reorder")
    );
    reorderBtn.type = "button";
    reorderBtn.setAttribute("data-session-id", String(order.sessionId || ""));
    actions.appendChild(reorderBtn);
    if (order.sessionId) {
      var status = el("a", "orders-status-link", tr("orders.statusLink", null, "Order status"));
      status.setAttribute(
        "href",
        "order-status.html?session_id=" + encodeURIComponent(order.sessionId)
      );
      actions.appendChild(status);
    }
    card.appendChild(actions);

    var note = el("p", "orders-reorder-note", "");
    note.setAttribute("role", "status");
    note.hidden = true;
    card.appendChild(note);
    reorderBtn.addEventListener("click", function () {
      note.hidden = false;
      reorder(order, note);
    });
    return card;
  }

  function renderLoyalty(loyalty) {
    var box = el("div", "orders-loyalty");
    var points = Number(loyalty.balance) || 0;
    box.appendChild(
      el(
        "p",
        "orders-loyalty-balance",
        tr("orders.points", { points: points }, "Alt-Points balance: " + points)
      )
    );
    var toGo = Number(loyalty.pointsToReward);
    var reward = money(loyalty.rewardCents, "usd");
    if (isFinite(toGo) && toGo > 0 && reward) {
      box.appendChild(
        el(
          "p",
          "muted",
          tr(
            "orders.pointsToGo",
            { points: toGo, reward: reward },
            toGo + " more and a " + reward + " code lands in your inbox on its own."
          )
        )
      );
    } else if (reward) {
      box.appendChild(
        el(
          "p",
          "muted",
          tr(
            "orders.pointsReady",
            null,
            "Your next reward code is on its way, or already in your inbox."
          )
        )
      );
    }
    return box;
  }

  function renderOrders(container, data) {
    while (container.firstChild) container.removeChild(container.firstChild);
    var orders = data && Array.isArray(data.orders) ? data.orders : [];
    var heading = el(
      "h2",
      "orders-list-heading",
      orders.length
        ? tr(
            "orders.heading",
            { count: orders.length },
            orders.length === 1 ? "Your order" : "Your " + orders.length + " orders"
          )
        : tr("orders.none", null, "No orders yet")
    );
    container.appendChild(heading);
    if (data && data.loyalty) container.appendChild(renderLoyalty(data.loyalty));
    if (!orders.length) {
      container.appendChild(
        el(
          "p",
          "muted",
          tr("orders.noneText", null, "Nothing has been placed with this address on the site yet.")
        )
      );
      return;
    }
    var list = el("div", "orders-list");
    for (var i = 0; i < orders.length; i++) list.appendChild(renderOrder(orders[i] || {}));
    container.appendChild(list);
  }

  function renderNotice(container, text, withMail) {
    while (container.firstChild) container.removeChild(container.firstChild);
    var p = el("p", "orders-notice", text);
    if (withMail) {
      p.appendChild(document.createTextNode(" "));
      var a = el("a", "", tr("orders.emailUs", null, "Email us"));
      a.setAttribute("href", mailtoHref());
      p.appendChild(a);
      p.appendChild(
        document.createTextNode(tr("orders.emailUsTail", null, " and we'll look it up by hand."))
      );
    }
    container.appendChild(p);
  }

  /* ---------------------------------------------------------- the network */

  function request(url, options) {
    var doFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
    if (!doFetch) return Promise.reject(new Error("fetch unavailable"));
    return doFetch(url, options).then(function (res) {
      var status = res && typeof res.status === "number" ? res.status : 0;
      if (!res || typeof res.json !== "function") return { status: status, data: null };
      return res.json().then(
        function (data) {
          return { status: status, data: data };
        },
        function () {
          return { status: status, data: null };
        }
      );
    });
  }

  function requestLink(email) {
    return request(LINK_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: email })
    });
  }

  function loadOrders(token) {
    return request(LIST_ENDPOINT + "?token=" + encodeURIComponent(token), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
  }

  /* Read ?token= and take it out of the address bar before the page settles,
     so it lands in no screenshot, no shared link and no history entry. */
  function takeTokenFromUrl() {
    var token = "";
    try {
      var params = new URLSearchParams(window.location.search);
      token = params.get("token") || "";
      if (token && window.history && typeof window.history.replaceState === "function") {
        window.history.replaceState(null, "", window.location.pathname);
      }
    } catch (e) {
      void e;
    }
    return token;
  }

  /* ---------------------------------------------------------- the page */

  function init() {
    var form = document.getElementById("ordersRequestForm");
    var emailInput = document.getElementById("ordersEmailInput");
    var submitBtn = document.getElementById("ordersRequestBtn");
    var errorEl = document.getElementById("ordersRequestError");
    var confirmEl = document.getElementById("ordersRequestConfirm");
    var card = document.getElementById("ordersRequestCard");
    var resultSection = document.getElementById("ordersResultSection");
    var listEl = document.getElementById("ordersList");
    if (!form || !listEl) return;

    function showList() {
      if (resultSection) resultSection.hidden = false;
    }

    if (!siteFlagEnabled("enableOrderHistory")) {
      if (card) card.hidden = true;
      showList();
      renderNotice(
        listEl,
        tr("orders.off", null, "Order history is switched off right now."),
        true
      );
      return;
    }

    /* Shipped disabled: with JavaScript off the form would GET itself and put
       the shopper's email in the URL. */
    if (submitBtn) submitBtn.disabled = false;

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = emailInput ? String(emailInput.value || "").trim() : "";
      if (errorEl) {
        errorEl.hidden = true;
        errorEl.textContent = "";
      }
      if (!email || email.indexOf("@") === -1 || !/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email)) {
        if (errorEl) {
          errorEl.textContent = tr(
            "orders.badEmail",
            null,
            "Please enter the email address you ordered with."
          );
          errorEl.hidden = false;
        }
        if (emailInput) emailInput.focus();
        return;
      }
      if (submitBtn) submitBtn.disabled = true;
      requestLink(email).then(
        function (res) {
          if (submitBtn) submitBtn.disabled = false;
          if (res.status === 200) {
            /* One confirmation for every address: the copy comes from the
               page (and so from /admin), not from the Worker. */
            form.hidden = true;
            if (confirmEl) {
              confirmEl.hidden = false;
              // Move focus to the confirmation so a screen reader announces it.
              confirmEl.setAttribute("tabindex", "-1");
              if (typeof confirmEl.focus === "function") confirmEl.focus();
            }
            return;
          }
          if (errorEl) {
            errorEl.textContent =
              res.status === 429
                ? tr(
                    "orders.rateLimited",
                    null,
                    "Too many requests. Please try again in ten minutes."
                  )
                : res.status === 404
                  ? tr("orders.off", null, "Order history is switched off right now.")
                  : res.status === 400 && res.data && res.data.error
                    ? tr(
                        "orders.badEmail",
                        null,
                        "Please enter the email address you ordered with."
                      )
                    : tr(
                        "orders.unavailable",
                        null,
                        "We couldn't send a link just now. Please try again in a minute."
                      );
            errorEl.hidden = false;
          }
        },
        function () {
          if (submitBtn) submitBtn.disabled = false;
          if (errorEl) {
            errorEl.textContent = tr(
              "orders.unavailable",
              null,
              "We couldn't send a link just now. Please try again in a minute."
            );
            errorEl.hidden = false;
          }
        }
      );
    });

    var token = takeTokenFromUrl();
    if (!token) return;

    showList();
    renderNotice(listEl, tr("orders.loading", null, "Opening your orders…"), false);
    loadOrders(token).then(
      function (res) {
        if (res.status === 200 && res.data && Array.isArray(res.data.orders)) {
          if (card) card.hidden = true;
          renderOrders(listEl, res.data);
          var h = listEl.querySelector("h2");
          if (h) {
            h.setAttribute("tabindex", "-1");
            h.focus();
          }
          return;
        }
        if (res.status === 403) {
          renderNotice(
            listEl,
            tr(
              "orders.linkUsed",
              null,
              "That link has expired or was already used. Ask for a fresh one below -- each link opens once."
            ),
            false
          );
          return;
        }
        if (res.status === 404) {
          if (card) card.hidden = true;
          renderNotice(
            listEl,
            tr("orders.off", null, "Order history is switched off right now."),
            true
          );
          return;
        }
        renderNotice(
          listEl,
          tr(
            "orders.unavailable",
            null,
            "We couldn't open your orders just now. Please try the link again in a minute."
          ),
          true
        );
      },
      function () {
        renderNotice(
          listEl,
          tr(
            "orders.unavailable",
            null,
            "We couldn't open your orders just now. Please try the link again in a minute."
          ),
          true
        );
      }
    );
  }

  /* Exposed for the test harnesses (scripts/orders-page.browser.test.js and
     any Node run of this file); nothing on the site reads it. */
  window.YL_ORDERS_PAGE = {
    cartLinesFor: cartLinesFor,
    renderOrders: renderOrders,
    statusWords: statusWords,
    money: money,
    safeLinkUrl: safeLinkUrl
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
