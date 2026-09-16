/* eslint-env browser */
/**
 * @fileoverview The fulfilment dashboard (admin/fulfillment.html): list the
 * orders still waiting to ship and push a tracking link + shipped status to
 * Stripe through the Worker (workers/routes/fulfillment.js).
 *
 * This lives in its own file, not an inline <script>, because the /admin/*
 * Content-Security-Policy (_headers, netlify.toml) is `script-src 'self'
 * https://unpkg.com` with no hash or 'unsafe-inline': an inline script is
 * blocked outright in production, and so is any inline on-click attribute. Every
 * handler here is attached with addEventListener for the same reason.
 *
 * THE PASSWORD NEVER TOUCHES STORAGE. It is asked for on every page load and
 * kept in a closure variable for the life of the page only. An earlier
 * version stashed it in web storage (session-scoped) on the public site origin, where any
 * script injection anywhere on the storefront could have read it back
 * (2026-09-16 audit). The "Lock" button drops it and reloads, which re-prompts.
 *
 * Everything the Worker returns is rendered through escapeHtml() before it
 * is put into innerHTML -- order emails, product names and variants are all
 * customer-typed strings.
 */
(function () {
  "use strict";

  var container = document.getElementById("app");
  var lockButton = document.getElementById("lock-btn");
  if (!container) return;

  var adminPassword = "";

  var EMPTY_STATE =
    '<div class="empty-state"><h3>All caught up!</h3>' +
    "<p>There are no orders waiting to be fulfilled.</p></div>";

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function authHeaders(extra) {
    var headers = { Authorization: "Bearer " + adminPassword };
    if (extra) {
      Object.keys(extra).forEach(function (key) {
        headers[key] = extra[key];
      });
    }
    return headers;
  }

  function showError(message) {
    container.innerHTML =
      '<div class="error-msg">Error: ' +
      escapeHtml(message) +
      ' <button type="button" id="retry-btn" class="btn-retry">Retry</button></div>';
    var retry = document.getElementById("retry-btn");
    if (retry) {
      retry.addEventListener("click", function () {
        window.location.reload();
      });
    }
  }

  function lock() {
    adminPassword = "";
    window.location.reload();
  }

  /** Reads the Worker's `{error}` body, falling back to a generic line. */
  function errorFrom(res) {
    return res
      .json()
      .catch(function () {
        return {};
      })
      .then(function (data) {
        var message =
          data && data.error ? String(data.error) : "Request failed (" + res.status + ")";
        return new Error(message);
      });
  }

  function itemsHtml(order) {
    var items;
    try {
      items = JSON.parse(order.line_items_json || "[]");
    } catch (e) {
      return "<li><em>Could not parse items</em></li>";
    }
    if (!Array.isArray(items)) return "<li><em>Could not parse items</em></li>";
    return items
      .map(function (item) {
        var name = escapeHtml(item && item.name != null ? item.name : "");
        var variant = item && item.variant ? " (" + escapeHtml(item.variant) + ")" : "";
        var qty = Number(item && item.quantity);
        var qtyText = Number.isFinite(qty) ? escapeHtml(String(qty)) : "?";
        return (
          "<li>" +
          '<span class="item-name">' +
          name +
          variant +
          "</span>" +
          '<span class="item-qty">Qty: ' +
          qtyText +
          "</span>" +
          "</li>"
        );
      })
      .join("");
  }

  function renderOrder(order) {
    var created = Number(order.created);
    var date = Number.isFinite(created) ? new Date(created * 1000).toLocaleDateString() : "";
    var amountCents = Number(order.amount_total);
    var amount = Number.isFinite(amountCents) ? (amountCents / 100).toFixed(2) : "?";
    var sessionId = String(order.session_id || "");
    var shortId = sessionId.split("_").pop();

    var card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      '<div class="card-header">' +
      "<div><strong>" +
      escapeHtml(order.email) +
      "</strong> &bull; $" +
      escapeHtml(amount) +
      "</div>" +
      '<div class="order-date">' +
      escapeHtml(date) +
      " &bull; " +
      escapeHtml(shortId) +
      "</div>" +
      "</div>" +
      '<div class="card-body">' +
      '<ul class="items-list">' +
      itemsHtml(order) +
      "</ul>" +
      '<form class="fulfillment-form">' +
      '<input type="url" name="tracking" maxlength="500" placeholder="Tracking URL (optional)" />' +
      '<button type="submit">Mark Shipped</button>' +
      "</form>" +
      "</div>";

    var form = card.querySelector("form");
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      submitOrder(form, String(order.payment_intent || ""));
    });
    return card;
  }

  function submitOrder(form, paymentIntent) {
    var button = form.querySelector("button");
    var input = form.querySelector("input");
    var tracking = input.value.trim();

    button.disabled = true;
    button.textContent = "Saving...";

    fetch("/api/fulfill-order", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        payment_intent: paymentIntent,
        tracking_url: tracking,
        status: "shipped"
      })
    })
      .then(function (res) {
        if (!res.ok) {
          return errorFrom(res).then(function (err) {
            throw err;
          });
        }
        var card = form.closest(".card");
        card.style.opacity = "0.5";
        setTimeout(function () {
          card.remove();
          if (!container.querySelector(".card")) container.innerHTML = EMPTY_STATE;
        }, 300);
      })
      .catch(function (err) {
        window.alert(err && err.message ? err.message : "Failed to update order");
        button.disabled = false;
        button.textContent = "Mark Shipped";
      });
  }

  function loadOrders() {
    fetch("/api/unfulfilled-orders", { headers: authHeaders() })
      .then(function (res) {
        if (!res.ok) {
          return errorFrom(res).then(function (err) {
            throw err;
          });
        }
        return res.json();
      })
      .then(function (data) {
        var orders = data && Array.isArray(data.orders) ? data.orders : [];
        if (orders.length === 0) {
          container.innerHTML = EMPTY_STATE;
          return;
        }
        container.innerHTML = "";
        orders.forEach(function (order) {
          container.appendChild(renderOrder(order));
        });
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : "Failed to load orders");
      });
  }

  if (lockButton) lockButton.addEventListener("click", lock);

  var entered = window.prompt("Please enter the fulfillment admin password:");
  if (!entered) {
    container.innerHTML =
      '<div class="error-msg">Authentication required to view the fulfillment dashboard. ' +
      "Reload the page to try again.</div>";
    return;
  }
  adminPassword = entered;
  entered = "";
  loadOrders();
})();
