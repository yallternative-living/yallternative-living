/**
 * @fileoverview Friendlier section names inside Sveltia CMS.
 *
 * Every section except the Journal is a Sveltia "singleton" (see the note at
 * the top of config.yml). Sveltia has no config option for how it names that
 * group: the sidebar heading and the editor header both say "Files", so the
 * owner opens "3. Customer Reviews" and lands on a page titled
 * "Editing Files". Decap's registerLocale() override is on Sveltia's
 * unsupported list, so this script renames those two spots from the outside:
 *   - the sidebar group heading "Files" becomes "Sections";
 *   - the editor header "Editing Files" / "Creating Files" uses the section's
 *     own label from config.yml, found via the #/collections/_singletons/...
 *     route the CMS is on.
 * It only ever rewrites text that reads exactly "Files" in those two places,
 * so if a future Sveltia release changes its markup or wording this does
 * nothing and the stock UI shows through unchanged.
 */
(function () {
  "use strict";

  var GROUP_LABEL = "Sections";
  var ISOLATE = /[⁨⁩]/g; // Sveltia wraps interpolated names in FSI/PDI marks
  var labels = {};
  /* site.enableJournal from content.json. While the Journal is switched off
     (section 6 -> Site Settings & Switches), its sidebar entry is hidden so
     the list shows only what is live; nothing is deleted -- turning the
     switch back on brings the entry back on the next load. `null` until the
     file has been read, which leaves the entry visible. */
  var journalEnabled = null;

  /* Top-level section labels (2-space "- name:" items under singletons: /
     collections:). Deeper fields are indented further, so they never match. */
  function loadLabels() {
    var link = document.querySelector('link[rel="cms-config-url"]');
    var url = (link && link.getAttribute("href")) || "config.yml";
    return fetch(url, { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.text() : "";
      })
      .then(function (text) {
        var re = /\n {2}- name: ([\w-]+)\n(?: {4}[^\n]*\n)*? {4}label: "?([^"\n]*?)"?\n/g;
        var m;
        while ((m = re.exec(text))) labels[m[1]] = m[2];
      })
      .catch(function () {
        /* no labels: the header keeps Sveltia's wording */
      });
  }

  function loadJournalSwitch() {
    /* content.json sits beside the site, not beside the config, so resolve
       from the page origin -- /admin/ and the preview harness both work. */
    var url = new URL("/assets/data/content.json", location.href).toString();
    return fetch(url, { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        var site = data && data.site;
        journalEnabled = site && typeof site.enableJournal === "boolean" ? site.enableJournal : null;
      })
      .catch(function () {
        journalEnabled = null;
      });
  }

  /* The sidebar is a listbox: each collection is a button[role="option"]
     carrying its label in data-label (Sveltia 0.172). The Journal is also
     the FIRST collection, so it is where the CMS lands on login; with the
     switch off, send that landing to the shop instead. Both are no-ops if a
     future Sveltia changes its markup. */
  function hideJournalWhenOff() {
    if (journalEnabled !== false) return;
    var label = labels.journal || "Journal";
    var options = document.querySelectorAll('button[role="option"][data-label]');
    for (var i = 0; i < options.length; i++) {
      var opt = options[i];
      if (opt.getAttribute("data-label").replace(ISOLATE, "").trim() !== label) continue;
      var item = opt.closest(".option") || opt;
      if (item.style.display !== "none") item.style.display = "none";
    }
    if (/^#\/collections\/journal(\/|$)/.test(location.hash)) {
      location.hash = "#/collections/_singletons/entries/products";
    }
  }

  function currentSingletonLabel() {
    var m = /#\/collections\/_singletons\/entries\/([\w-]+)/.exec(location.hash);
    return m && labels[m[1]] ? labels[m[1]] : null;
  }

  function rename() {
    hideJournalWhenOff();
    var spans = document.querySelectorAll("span.truncated-text");
    for (var i = 0; i < spans.length; i++) {
      var span = spans[i];
      var text = span.textContent.replace(ISOLATE, "").trim();
      if (
        text === "Files" &&
        span.parentElement &&
        span.parentElement.classList.contains("label")
      ) {
        setText(span, GROUP_LABEL);
      } else if (/^(Creating|Editing) Files$/.test(text) && span.closest("h2")) {
        var label = currentSingletonLabel();
        if (label) setText(span, text.replace("Files", label));
      } else if (/^Files › /.test(text) && span.closest("h2")) {
        /* The editor breadcrumb is one string, "Files › 6. ⚙️ Site Settings"
           (with Sveltia's isolate marks around each part): same group name
           as the sidebar heading, so the same rename, leading word only. */
        for (var n = span.firstChild; n; n = n.nextSibling) {
          if (n.nodeType === 3 && /Files/.test(n.textContent)) {
            var next = n.textContent.replace(/^(\u2068?)Files(\u2069?)/, "$1" + GROUP_LABEL + "$2");
            if (next !== n.textContent) n.textContent = next;
            break;
          }
        }
      }
    }
  }

  function setText(span, value) {
    /* Write into the existing text node so Svelte's own reference stays valid. */
    for (var n = span.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.textContent.trim()) {
        if (n.textContent !== value) n.textContent = value;
        return;
      }
    }
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      rename();
    });
  }

  Promise.all([loadLabels(), loadJournalSwitch()]).then(function () {
    rename();
    new MutationObserver(schedule).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
    window.addEventListener("hashchange", schedule);
  });
})();
