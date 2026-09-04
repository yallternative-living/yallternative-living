/* eslint-env browser */
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
 *     route the CMS is on;
 *   - the same rename applies to the "Files › ..." editor breadcrumb.
 * It only ever rewrites text that reads exactly "Files" (or "Files › ...")
 * in those spots, so if a future Sveltia release changes its markup or
 * wording this does nothing and the stock UI shows through unchanged.
 *
 * While site.enableJournal is off, this also hides the Journal row from the
 * sidebar (nothing is deleted -- flipping the switch back on brings the row
 * back on the next load).
 *
 * IMPORTANT -- no forced redirect away from Journal (2026-09-04):
 * An earlier version of this file also force-navigated away from Journal
 * (`location.hash = "#/collections/_singletons/entries/products"`) whenever
 * login landed there with the switch off, so the owner would land on Shop &
 * Products instead of a hidden, dead-end row. That line has been removed
 * after tracing today's "I don't see a Site Settings category" report to it.
 *
 * What's actually going on is a pre-existing Sveltia 0.172.4 (also
 * reproduced against the latest 0.205.2 release from unpkg, so it is not
 * fixed by bumping the pin) bug: once ANY singleton entry has been opened in
 * a browser session, the NEXT DIFFERENT singleton entry opened in that same
 * session renders with an empty field list (no console error -- it just
 * silently comes up blank, Save disabled). This reproduces with cms-labels.js
 * removed from the page entirely, and with a plain, unscripted pair of
 * sidebar clicks -- it has nothing to do with this file's MutationObserver,
 * its hideJournalWhenOff() logic, or the breadcrumb rename (all individually
 * ruled out; see the bisection notes shipped alongside this file). The old
 * redirect line just happened to be the thing silently opening a FIRST
 * singleton entry (Shop & Products) on every login, which made whatever the
 * owner opened next -- in practice, Site Settings -- the broken "next
 * different singleton" and thus permanently empty for the rest of that
 * session.
 *
 * Removing the auto-redirect avoids that trap: the owner's own first click
 * is now the session's first singleton entry again, so it (and everything
 * they open after it, as long as they don't revisit an already-open one)
 * renders normally. The trade-off is that with the switch off, login no
 * longer auto-lands on Shop & Products -- it stays on Sveltia's own default
 * (the Journal collection list), just with that row hidden from the sidebar.
 * This is a real product-behavior regression from the previous version, not
 * a cosmetic one; it should be tracked (e.g. "restore the Shop & Products
 * auto-redirect once the underlying Sveltia bug is fixed or worked around")
 * rather than treated as done. See DEVELOPMENT.md / the bisection notes
 * before re-adding any equivalent of the old redirect -- every mechanism
 * tried (a direct location.hash write, the same write deferred 300ms, and a
 * synthetic click on the target sidebar button) reproduced the identical
 * failure, so this is not a timing race to paper over with a longer delay.
 */
(function () {
  "use strict";

  var GROUP_LABEL = "Sections";
  var ISOLATE = /[⁨⁩]/g; // Sveltia wraps interpolated names in FSI/PDI marks
  var labels = {};
  /* site.enableJournal from content.json. While the Journal is switched off
     (section 6 -> Switches & branding), its sidebar entry is hidden so
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
     carrying its label in data-label (Sveltia 0.172). Hide the Journal row
     while its switch is off. This is deliberately CSS-only (no navigation):
     see the file-level comment above for why a forced redirect away from
     Journal is not safe to do here. No-op if a future Sveltia changes its
     markup. */
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
            var next = n.textContent.replace(/^(⁨?)Files(⁩?)/, "$1" + GROUP_LABEL + "$2");
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

  /* Sveltia 0.172.4 (and 0.205.2) renders the SECOND singleton entry opened
     in one page session with an empty field list -- no error, Save stays
     disabled. Bisected 2026-09-03 with no other script loaded: click Shop &
     Products then Site Settings -> 0/5 renders; open Site Settings first ->
     5/5. Until it is fixed upstream, opening a DIFFERENT singleton than the
     one this page load opened first reloads the page, so every section
     opens as the session's first entry.

     Only the singleton entry route counts. The first cut also matched the
     list routes ("#/collections/journal", "#/collections/_singletons"), so
     going back to the list registered as "an entry" and every step reloaded
     two or three times (validated 2026-09-04). Nothing reloads while the
     user is inside the same section, on a list, or in a Journal post.

     Never reload over an unsaved edit: if Sveltia's Save button is enabled
     at the moment of the switch, the edit has not been backed up yet, and a
     reload would discard it silently. In that case the switch proceeds
     without a reload (the second-entry bug may then show, and a plain
     browser reload recovers it) -- losing the edit is the worse outcome. */
  var SINGLETON_ENTRY = /^#\/collections\/_singletons\/entries\/([\w-]+)/;
  var openedEntry = null;
  function hasUnsavedEdit() {
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (/^\s*Save\s*$/.test(b.textContent.replace(ISOLATE, "")) && !b.disabled) return true;
    }
    return false;
  }
  function reloadOnSectionSwitch() {
    var m = SINGLETON_ENTRY.exec(location.hash);
    if (!m) return;
    if (openedEntry === null) {
      openedEntry = m[1];
      return;
    }
    if (m[1] === openedEntry) return;
    if (hasUnsavedEdit()) return;
    location.reload();
  }
  reloadOnSectionSwitch();
  window.addEventListener("hashchange", reloadOnSectionSwitch);

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
