/* ==========================================================
   Y'ALLTERNATIVE LIVING | welcome.html -- the single-use welcome code

   WHY THIS FILE EXISTS
   The welcome discount used to be one string in the CMS (site.welcomeCode),
   printed on this page for every visitor, forever, with no expiry and no usage
   cap -- a public 10%-off code behind a signup wall that checked nothing. This
   asks the Worker for a real Stripe Promotion Code instead: minted per address,
   `max_redemptions: 1`, `restrictions[first_time_transaction]: true`, expiring
   in 45 days. See POST /api/welcome-code in workers/routes/retention.js.

   WHY IT LOADS BEFORE main.js
   main.js has its own block that writes site.welcomeCode into #welcomeCode and
   unhides the card (assets/js/main.js, "Welcome page: show the subscriber
   discount code"). Two writers for one card means a race and a flash of the
   shared code. Deferred scripts run in document order, so this file runs first
   and RENAMES that element's id -- main.js then finds nothing, does nothing,
   and this file owns every state the card can be in, including falling back to
   the CMS string when the route reports it is not configured.

   That rename is the one piece of coupling here: if main.js's block is ever
   removed, delete the rename with it (the element keeps working either way,
   because everything below addresses it by the reference taken here).
   ========================================================== */
(function () {
  "use strict";

  var card = document.getElementById("welcomeCodeCard");
  var codeEl = document.getElementById("welcomeCode");
  var noCode = document.getElementById("welcomeNoCode");
  var form = document.getElementById("welcomeCodeForm");
  var status = document.getElementById("welcomeCodeStatus");
  if (!card || !codeEl) return;

  /* Claim the card. See the header: this is what stops main.js writing the
     shared CMS code into it a moment later. */
  codeEl.removeAttribute("id");

  var ENDPOINT = "/api/welcome-code";
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function say(message, isError) {
    if (!status) return;
    status.textContent = message;
    status.hidden = false;
    status.setAttribute("role", isError ? "alert" : "status");
  }

  function clearStatus() {
    if (!status) return;
    status.textContent = "";
    status.hidden = true;
  }

  function showCode(code) {
    codeEl.textContent = code;
    card.hidden = false;
    if (form) {
      form.hidden = true;
      form.style.display = "none";
    }
    clearStatus();
  }

  function showForm(message) {
    if (!form) {
      /* No form in the markup to fall back to: say where the code is coming
         from rather than leaving a blank page. */
      showFallbackOrNothing();
      return;
    }
    form.hidden = false;
    form.style.display = "flex";
    if (message) say(message, false);
  }

  /* The last resort, and the ONLY place the static CMS code is still used: the
     Worker told us it has no coupon configured, so a per-person code cannot
     exist yet. Showing the shared code here is honest -- it is the code that
     actually works today. With no code configured either, this reveals the
     "it's coming by email" copy, exactly as main.js used to. */
  function showFallbackOrNothing() {
    var site = (window.YL_CONTENT && window.YL_CONTENT.site) || {};
    var fallback = site.welcomeCode;
    if (fallback && fallback !== "YOUR_WELCOME_CODE") {
      showCode(fallback);
      return;
    }
    if (form) {
      form.hidden = true;
      form.style.display = "none";
    }
    clearStatus();
    if (noCode) noCode.hidden = false;
  }

  function request(email) {
    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: email })
    }).then(function (res) {
      return res.json().then(
        function (body) {
          return { ok: res.ok, body: body || {} };
        },
        function () {
          return { ok: false, body: {} };
        }
      );
    });
  }

  function claim(email, fromForm) {
    var button = form ? form.querySelector('button[type="submit"]') : null;
    var label = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "Getting it...";
    }
    say("Making your code...", false);

    return request(email)
      .then(function (result) {
        if (button) {
          button.disabled = false;
          button.textContent = label;
        }
        if (result.ok && result.body.configured === false) {
          /* Documented state, not a failure: no shared coupon id is set on the
             Worker yet. */
          showFallbackOrNothing();
          return;
        }
        if (result.ok && typeof result.body.code === "string" && result.body.code) {
          showCode(result.body.code);
          return;
        }
        /* A real refusal. Never invent a code and never silently show the
           shared one as if it were personal -- say what happened, and let them
           try again if they typed the address wrong. */
        var message =
          result.status === 429
            ? "A few tries in a row; give it a minute and try again."
            : "We couldn't make your code just now. Try again in a moment.";
        if (fromForm) {
          say(message, true);
        } else {
          showForm(message);
        }
      })
      .catch(function () {
        if (button) {
          button.disabled = false;
          button.textContent = label;
        }
        var message = "We couldn't reach the server. Try again in a moment.";
        if (fromForm) say(message, true);
        else showForm(message);
      });
  }

  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = document.getElementById("welcome_email");
      var typed = input ? input.value.trim() : "";
      if (!EMAIL_RE.test(typed)) {
        say("That doesn't look like an email address.", true);
        return;
      }
      claim(typed, true);
    });
  }

  /* Kit's post-confirmation redirect is configured in Kit's own dashboard and
     does not carry the subscriber's address today. These three parameter names
     cover the ones Kit and the usual bridges use, so if that redirect is ever
     configured to pass it along, this page picks it up with no code change --
     and until then it simply asks. */
  var emailFromUrl = "";
  try {
    var params = new URLSearchParams(window.location.search);
    emailFromUrl = (
      params.get("email") ||
      params.get("email_address") ||
      params.get("subscriber_email") ||
      ""
    ).trim();
  } catch {
    emailFromUrl = "";
  }
  /* Never leave a subscriber's address in the address bar, history or a
     shared link (verify-D M-8): same scrub safety.js does for its query. */
  if (emailFromUrl && window.history && typeof window.history.replaceState === "function") {
    try {
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    } catch {
      /* ignore */
    }
  }

  if (typeof fetch !== "function") {
    /* No fetch (a very old browser): the shared CMS code is the only thing this
       page can honestly offer. */
    showFallbackOrNothing();
    return;
  }

  if (EMAIL_RE.test(emailFromUrl)) {
    claim(emailFromUrl, false);
  } else {
    /* Kit's confirmation redirect does not pass the address along, so we
       genuinely do not have it here -- say so, rather than looking like we
       forgot (live audit nit). */
    showForm(
      "Kit didn't pass your address along with the redirect, so pop it in once " +
        "more and we'll make your code."
    );
  }
})();
