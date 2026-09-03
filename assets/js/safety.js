/**
 * @fileoverview safety.html -- the MoCRA "report a reaction" form.
 *
 * PROGRESSIVE ENHANCEMENT, NOT A REQUIREMENT.
 * The form in the markup is a plain `POST /api/safety-report` and works with
 * JavaScript switched off: the Worker (workers/routes/safety-report.js) reads a
 * form-encoded body and answers a form post with a 303 back to this page
 * carrying `?report=received&ref=<reference>`. This file makes that nicer --
 * it fills the product list from the real catalogue, validates before the round
 * trip, and swaps in a success panel without a reload. Everything it does is an
 * improvement on a path that already works.
 *
 * NO ANALYTICS. Not one event, not even a content-free "form submitted" ping.
 * What a person types into this form is health information about themselves;
 * the shop's analytics vendor has no business knowing that a visitor on this
 * page reached the submit button, and a counter is not worth the argument.
 *
 * ERRORS ARE ANNOUNCED, NOT JUST COLOURED. Each field's message lives in an
 * element the input points at with aria-describedby, `aria-invalid` is set on
 * the control, focus moves to the first bad field, and the form-level message
 * sits in a `role="alert"` region so a screen reader hears it without hunting.
 */
(function () {
  "use strict";

  var form = document.getElementById("safetyForm");
  if (!form) return;

  var successPanel = document.getElementById("safetySuccess");
  var emailUsPanel = document.getElementById("safetyEmailUs");
  var referenceOut = document.getElementById("safetyReference");
  var formError = document.getElementById("safetyFormError");
  var submitBtn = document.getElementById("safetySubmit");
  var productSelect = document.getElementById("safety-product");

  var ENDPOINT = form.getAttribute("action") || "/api/safety-report";

  /* ------------------------------------------------------------ product list
     Built from the same window.YL_PRODUCTS every other page reads, so a
     product added in /admin appears here on the next build with no edit to
     this file. "Other, or I'm not sure" is in the static markup and stays
     last: a person who cannot identify the jar still has to be able to file. */
  function fillProducts() {
    if (!productSelect) return;
    var catalog = window.YL_PRODUCTS || {};
    var products = Array.isArray(catalog.products) ? catalog.products : [];
    if (!products.length) return;
    /* The build already injects the catalogue (so the list works with
       JavaScript off); only fill it here when that did not happen. */
    if (productSelect.querySelectorAll("option").length > 2) return;
    var other = productSelect.querySelector('option[value="other"]');
    products.forEach(function (product) {
      if (!product || !product.id || !product.name) return;
      /* A digital gift card cannot cause a reaction; leave it off the list. */
      if (product.id === "yallternative-gift-card" || product.category === "gift-cards") return;
      var option = document.createElement("option");
      option.value = String(product.id);
      option.textContent = String(product.name);
      if (other) productSelect.insertBefore(option, other);
      else productSelect.appendChild(option);
    });
  }

  /* ------------------------------------------------------------- validation */

  var FIELDS = [
    {
      input: "safety-description",
      error: "safety-description-error",
      message: "Please tell us what happened, in your own words.",
      valid: function (value) {
        return value.trim().length >= 2;
      }
    },
    {
      input: "safety-email",
      error: "safety-email-error",
      message: "Please give an email address we can reach you at.",
      valid: function (value) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
      }
    }
  ];

  function setFieldError(spec, message) {
    var input = document.getElementById(spec.input);
    var target = document.getElementById(spec.error);
    if (!input || !target) return;
    if (message) {
      target.textContent = message;
      target.hidden = false;
      input.setAttribute("aria-invalid", "true");
    } else {
      target.textContent = "";
      target.hidden = true;
      input.removeAttribute("aria-invalid");
    }
  }

  function showFormError(message) {
    if (!formError) return;
    formError.textContent = message;
    formError.hidden = !message;
    if (!message) return;
    /* The message used to land 2,000px above the button with no scroll and
       no focus, so a refused report looked like nothing happened (verify-D
       M-3). Bring it into view and give it focus, as the success panel does. */
    formError.setAttribute("tabindex", "-1");
    if (typeof formError.scrollIntoView === "function") {
      formError.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    formError.focus({ preventScroll: true });
  }

  /** @returns {HTMLElement|null} the first invalid control, or null. */
  function validate() {
    var firstBad = null;
    FIELDS.forEach(function (spec) {
      var input = document.getElementById(spec.input);
      if (!input) return;
      if (spec.valid(input.value || "")) {
        setFieldError(spec, "");
        return;
      }
      setFieldError(spec, spec.message);
      if (!firstBad) firstBad = input;
    });
    return firstBad;
  }

  // Clear a field's error as soon as it becomes valid, so the message does not
  // sit there contradicting what the person is looking at.
  FIELDS.forEach(function (spec) {
    var input = document.getElementById(spec.input);
    if (!input) return;
    input.addEventListener("input", function () {
      if (spec.valid(input.value || "")) setFieldError(spec, "");
    });
  });

  /* ---------------------------------------------------------------- payload */

  function collect() {
    var data = new FormData(form);
    var body = {};
    [
      "product_id",
      "lot",
      "channel",
      "first_use_date",
      "reaction_date",
      "body_area",
      "description",
      "stopped_use",
      "reporter_name",
      "email",
      "reporter_phone",
      "age_range",
      "sex",
      "website_hp"
    ].forEach(function (key) {
      var value = data.get(key);
      body[key] = value === null ? "" : String(value);
    });
    body.outcomes = data.getAll("outcomes").map(String);
    body.contact_consent = Boolean(data.get("contact_consent"));
    return body;
  }

  /* -------------------------------------------------------------- rendering */

  function showSuccess(reference) {
    if (referenceOut) referenceOut.textContent = reference || "in the email we just sent you";
    showFormError("");
    if (successPanel) {
      successPanel.hidden = false;
      successPanel.setAttribute("tabindex", "-1");
      successPanel.focus();
    }
    form.hidden = true;
  }

  /* The Worker accepted the request but filed nothing (the honeypot path).
     The form stays on screen -- a false positive on that hidden field is
     exactly the case this exists for, and the person may well want to try
     again -- but nothing here may read like a receipt (live audit M11). */
  function showEmailUs() {
    showFormError("");
    if (emailUsPanel) {
      emailUsPanel.hidden = false;
      emailUsPanel.setAttribute("tabindex", "-1");
      emailUsPanel.focus();
      return;
    }
    showFormError(
      "We could not file that report and nothing was saved. Please email " +
        "y.allternative.living@gmail.com and tell us what happened."
    );
  }

  /* ------------------------------------------------------------ the no-JS
     return trip. The Worker's 303 lands back here with the outcome in the
     query string; render it the same way an in-page submit would, then scrub
     the parameters out of the address bar so a refresh or a shared link does
     not re-announce someone's report. */
  function readReturnState() {
    var params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (e) {
      return;
    }
    var state = params.get("report");
    if (!state) return;
    if (state === "received") {
      showSuccess(params.get("ref") || "");
    } else if (state === "email-us") {
      showEmailUs();
    } else {
      showFormError(
        "We could not file that report. Please try again, or email " +
          "y.allternative.living@gmail.com so it does not get lost."
      );
    }
    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    }
  }

  /* --------------------------------------------------------------- submit */

  form.addEventListener("submit", function (event) {
    if (!window.fetch) return; // let the plain POST happen
    event.preventDefault();

    var firstBad = validate();
    if (firstBad) {
      showFormError("There's a bit still missing. Check the highlighted fields below.");
      firstBad.focus();
      return;
    }
    showFormError("");

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending…";
    }

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collect())
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (payload) {
            return { ok: res.ok, status: res.status, payload: payload };
          });
      })
      .then(function (result) {
        if (result.ok && result.payload && result.payload.ok) {
          if (result.payload.filed === false) {
            showEmailUs();
            return;
          }
          showSuccess(result.payload.reference);
          return;
        }
        /* Never print the server's own error string: a shopper filing a
           reaction report must always get a plain explanation and the email
           fallback, whatever the Worker or the edge answered. The one code
           worth translating is the rate limit. */
        var code =
          result.payload && typeof result.payload.error === "string" ? result.payload.error : "";
        var lead =
          code === "rate_limited" || result.status === 429
            ? "That is a few tries in a row; give it a minute and send it again. "
            : "We could not file that report just now. Please try again in a moment. ";
        showFormError(
          lead +
            "If it still will not go through, email y.allternative.living@gmail.com so it does not get lost."
        );
      })
      .catch(function () {
        showFormError(
          "We could not reach the server. Check your connection and try again, or email " +
            "y.allternative.living@gmail.com so it does not get lost."
        );
      })
      .then(function () {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Send Report";
        }
      });
  });

  // Native validation is switched off only once this script is running, so a
  // visitor with JS disabled keeps the browser's own required-field handling.
  form.noValidate = true;

  fillProducts();
  readReturnState();
})();
