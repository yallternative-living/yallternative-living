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
 * AUTH IS THE CMS SIGN-IN -- THERE IS NO DASHBOARD PASSWORD ANY MORE. The
 * shared password was deleted outright on 2026-09-16 (no fallback: a fallback
 * password would keep exactly the weakness being removed). Instead this page
 * reuses the GitHub token Sveltia CMS already stored when the owner signed in
 * at /admin/, and the Worker verifies that token with GitHub and requires push
 * access to the shop repository before it answers. See readGitHubToken() for
 * where the token comes from. Nothing on this page ever WRITES to storage; that
 * one read is the only storage access here.
 *
 * Every request goes to same-origin /api/* only, so the /admin/* CSP needs no
 * connect-src change.
 *
 * Everything the Worker returns is rendered through escapeHtml() before it
 * is put into innerHTML -- order emails, product names and variants are all
 * customer-typed strings.
 */
(function () {
  "use strict";

  var container = document.getElementById("app");
  if (!container) return;

  /** Where Sveltia CMS keeps the signed-in user. See readGitHubToken(). */
  var USER_STORAGE_KEY = "sveltia-cms.user";

  var SIGN_IN_LINK = '<a href="/admin/">Sign in to the CMS</a>';

  var LOADING_STATE = '<div class="empty-state">Loading unfulfilled orders...</div>';

  var EMPTY_STATE =
    '<div class="empty-state"><h3>All caught up!</h3>' +
    "<p>There are no orders waiting to be fulfilled.</p></div>";

  // Plain-English copy: a shop owner reads this page, not a developer. The
  // Worker's own {error} text is developer-facing, so these replace it for the
  // statuses we understand (401 / 403 / 429).
  var SIGNED_OUT_HEADING = "You are signed out";
  var SIGNED_OUT_TEXT =
    "This dashboard uses the same GitHub sign-in as the CMS. " +
    "Sign in there, then come back to this page.";

  var EXPIRED_HEADING = "Your sign-in has expired";
  var EXPIRED_TEXT =
    "Your GitHub sign-in has expired or you have been signed out. " +
    "Sign in to the CMS again, then come back to this page.";

  var NO_ACCESS_HEADING = "This account cannot manage orders";
  var NO_ACCESS_TEXT =
    "This GitHub account does not have permission to manage this shop's orders. " +
    "Sign in with the GitHub account that owns the shop, then try again.";

  var BUSY_TEXT = "That was a lot of requests at once. Wait about a minute, then try again.";

  var GENERIC_TEXT = "Something went wrong. Please try again.";

  /** Alerts cannot hold a link, so the address is spelled out instead. */
  var CMS_ADDRESS_HINT = " The CMS sign-in is at /admin/ on this site.";

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /**
   * The GitHub token Sveltia CMS stored when the owner signed in at /admin/.
   *
   * Sveltia keeps the signed-in user in localStorage under the key
   * "sveltia-cms.user", as JSON: {backendName, id, name, login, email,
   * avatarURL, profileURL, bot, token}. The GitHub token is a bare string at
   * the top level (`.token`, a gho_... value). localStorage is origin-scoped
   * and not path-scoped, so /admin/fulfillment.html reads what
   * /admin/index.html wrote.
   *
   * The quirk that shapes the check below: signing OUT does not remove the key,
   * it overwrites it with the literal `{}`. That parses perfectly well and
   * yields an object with NO `token`, so "did it parse?" is the wrong question
   * -- the token itself has to be a non-empty string. Never signed in at all
   * and getItem returns null; in private mode or with site data blocked the
   * read itself throws, hence the try/catch.
   *
   * @returns {string|null} the token, or null whenever there is not a usable one
   */
  function readGitHubToken() {
    var raw;
    try {
      raw = window.localStorage.getItem(USER_STORAGE_KEY);
    } catch (e) {
      return null;
    }
    if (!raw) return null;

    var user;
    try {
      user = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    if (!user || typeof user.token !== "string" || !user.token) return null;
    return user.token;
  }

  /**
   * Builds the request headers. The token is read at CALL time, not once at
   * load time, so signing in from another tab is picked up by the next action
   * here without reloading this page.
   */
  function getAuthHeaders(extra) {
    var token = readGitHubToken();
    var headers = { Authorization: "Bearer " + (token || "") };
    if (extra) {
      Object.keys(extra).forEach(function (key) {
        headers[key] = extra[key];
      });
    }
    return headers;
  }

  function wireRetry(handler) {
    var retry = document.getElementById("retry-btn");
    if (retry) retry.addEventListener("click", handler);
  }

  /**
   * The signed-out / wrong-account state: an explanation, the CMS sign-in link
   * and a button that re-runs the load once she has signed in.
   */
  function showSignInNeeded(heading, message) {
    container.innerHTML =
      '<div class="empty-state"><h3>' +
      escapeHtml(heading) +
      "</h3><p>" +
      escapeHtml(message) +
      "</p><p>" +
      SIGN_IN_LINK +
      '</p><p><button type="button" id="retry-btn" class="btn-retry">Check again</button></p></div>';
    wireRetry(start);
  }

  function showError(message) {
    container.innerHTML =
      '<div class="error-msg">Error: ' +
      escapeHtml(message) +
      ' <button type="button" id="retry-btn" class="btn-retry">Retry</button></div>';
    wireRetry(start);
  }

  /** Reads the Worker's `{error}` body, keeping the status for the copy below. */
  function errorFrom(res) {
    return res
      .json()
      .catch(function () {
        return {};
      })
      .then(function (data) {
        var message =
          data && data.error ? String(data.error) : "Request failed (" + res.status + ")";
        var err = new Error(message);
        err.status = res.status;
        return err;
      });
  }

  /**
   * Renders whatever went wrong. 401 (no/expired/rejected token) and 403 (valid
   * token, but no push access to the shop repo) get the sign-in state; 429 and
   * everything else (503 included) get the error box with Retry. Every branch
   * paints something -- leaving "Loading unfulfilled orders..." on screen for
   * ever would be the bug.
   */
  function showFailure(err) {
    var status = err && err.status;
    if (status === 401) {
      showSignInNeeded(EXPIRED_HEADING, EXPIRED_TEXT);
    } else if (status === 403) {
      showSignInNeeded(NO_ACCESS_HEADING, NO_ACCESS_TEXT);
    } else if (status === 429) {
      showError(BUSY_TEXT);
    } else {
      showError(err && err.message ? err.message : GENERIC_TEXT);
    }
  }

  /** The same mapping, worded for the alert a failed "Mark Shipped" raises. */
  function failureMessage(err) {
    var status = err && err.status;
    if (status === 401) return EXPIRED_TEXT + CMS_ADDRESS_HINT;
    if (status === 403) return NO_ACCESS_TEXT + CMS_ADDRESS_HINT;
    if (status === 429) return BUSY_TEXT;
    return err && err.message ? err.message : GENERIC_TEXT;
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
      headers: getAuthHeaders({ "Content-Type": "application/json" }),
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
        // Never fail silently: a 401 or 403 has to reach her in words, not just
        // leave the button stuck on "Saving...".
        window.alert(failureMessage(err));
        button.disabled = false;
        button.textContent = "Mark Shipped";
      });
  }

  function loadOrders() {
    fetch("/api/unfulfilled-orders", { headers: getAuthHeaders() })
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
      .catch(showFailure);
  }

  /**
   * Entry point, and what "Check again" / "Retry" re-run. No token means no
   * request at all -- just the sign-in state, so a signed-out visit never sits
   * on the loading line.
   */
  function start() {
    if (!readGitHubToken()) {
      showSignInNeeded(SIGNED_OUT_HEADING, SIGNED_OUT_TEXT);
      return;
    }
    container.innerHTML = LOADING_STATE;
    loadOrders();
  }

  start();
})();
