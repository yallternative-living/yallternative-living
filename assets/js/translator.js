/* ==========================================================
   Y'ALLTERNATIVE LIVING | Self-Hosted Client-Side Localization Engine
   ----------------------------------------------------------
   Lightweight, zero-external-dependency, cookieless translation engine.
   Translates text nodes, data-i18n elements, placeholders, and aria-labels
   in-place using compiled locale dictionaries and brand glossary rules.

   TEMPLATES ("tpl.*" keys) -- for strings JS or the build composes with a
   variable in the MIDDLE ("Add $25 Gift Card to Cart", "Write a review of
   Sleep Salve"). The whole-node matcher above only ever sees the FINISHED
   string, and no single English phrase equals every amount's or product's
   version of it, so those strings need two extra pieces instead of one
   dictionary entry:
     - A "tpl.*" dictionary phrase with {name} placeholders, e.g.
       "tpl.addGiftCard": "Add {amount} Gift Card to Cart", translated per
       locale the same as any other phrase.
     - Two ways to apply it, picked per call site by whether the string can
       change again after it is first rendered:
         (a) COMPOSITION TIME -- call the exported t(key, vars) (also
             window.YL_T) instead of concatenating, wherever the string is
             built. Required for anything that can be re-rendered by an
             event handler while already on screen (the gift-card button's
             amount changes on every keystroke) -- those sites also need to
             re-run their own render function on the "yl-language-changed"
             event so a language switch updates already-visible text.
         (b) TRANSLATION TIME -- mark up the element with
             data-i18n-tpl="tpl.someKey" (textContent) or
             data-i18n-tpl-placeholder / -aria-label / -title (that
             attribute), plus data-i18n-vars='{"product":"...","n":2}' (a
             JSON object). translateNode() below fills it in with t() on
             every pass, so it "just works" for anything rendered once and
             left alone -- an aria-label built in a loop, a heading the
             build wrote into static HTML -- with no JS-side language
             awareness needed at all, including for elements the
             MutationObserver discovers after the fact.
   Either way the value substituted for each {name} is run back through the
   normal phrase dictionary first (see renderTemplate()): a var that is ALSO
   a dictionary phrase (a category name) comes back translated, one that
   isn't (a product name, protected by the brand glossary; a dollar amount;
   a bare count) comes back verbatim. Restoring English still restores the
   exact original text/attribute from the same __ylOriginal* cache every
   other path here uses, so a template key can never leave a page unable to
   get back to its authored copy.
   ========================================================== */
/* global module, global, require */
(function () {
  "use strict";

  var LANGUAGES = [
    { code: "en", name: "English" },
    { code: "es", name: "Español" },
    { code: "de", name: "Deutsch" },
    { code: "fr", name: "Français" },
    { code: "ja", name: "日本語" },
    { code: "zh", name: "中文" },
    { code: "vi", name: "Tiếng Việt" },
    { code: "ko", name: "한국어" },
    { code: "pt", name: "Português" }
  ];

  var globeSVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="icon-globe" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>' +
    '<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>' +
    "</svg>";

  var currentLang = "en";
  var observer = null;
  var isTranslating = false;

  /* Per-element bookkeeping for the lang marking pass -- see applyLangMarks().
     Reset at the top of every translateTree() call. */
  var langHits = null;
  var langMisses = null;
  /* Every element this engine has stamped a lang attribute onto, so the switch
     back to English can put each one back exactly as it was. */
  var langMarkedElements = [];

  /* Handle of the pending "have the dictionaries landed yet?" timer. Only ever
     non-null when init() ran before locales-data.js did AND a non-English
     language was requested -- see waitForLocales(). */
  var pendingLocalesWatch = null;

  // Cached inverted dictionaries for fast O(1) text-to-key lookup
  var englishPhraseToKey = null;
  var normalizedPhraseToKey = null;
  var glossaryTermsSet = null;

  // Built-in hardcoded fallback list of core protected terms in case glossary is not yet loaded
  var FALLBACK_PROTECTED_TERMS = [
    "Y'allternative Living",
    "Y'allternative",
    "Landrum, SC",
    "Landrum",
    "Savanna",
    "Alt-Points",
    "Alt-Point",
    "YALL10",
    "Porch Sweep Clearing Mist",
    "Cathedral Dust",
    "Bless Your Heart",
    "Unbothered",
    "Hush Y'all Magnesium Arnica Sleep Salve",
    "Y'all Heal Now Miracle Frankincense Salve",
    "Y'allternative Miracle Balm",
    "Feral but FRESH Cream Deodorant",
    "Bug Off B*tch Natural Bug Spray",
    "Bourbon Beard Salve",
    "Bourbon Vanilla Hand Scrub",
    "Lavender Shea Body Butter",
    "Lavender Epsom Salt Soak",
    "Backroad Recovery Epsom Salt Soak",
    "Protection Potion Keychain",
    "Y'all Means All Sugar Scrub",
    "Y'all Means All Rainbow Whipped Body Butter",
    "Appalachian Rain Clearing Mist",
    "Moonlit Meadow Bath Tea",
    "Porch Sweep",
    "Grit & Grace Starter Set",
    "Bourbon & Grit Gift Set",
    "Backwoods Burnout Recovery Kit",
    "Y'all Means All Pride Set",
    "Everyday Armor Kit",
    "Gentle Landing Set",
    "Discovery Flight",
    "Y'all Means All",
    "Black Sheep & Bold Hearts",
    "Spotted In The Wild",
    "Pop Up In The Wild",
    "Calendula officinalis",
    "Arnica montana",
    "Boswellia carterii",
    "Butyrospermum parkii",
    "Cera alba",
    "Lavandula angustifolia",
    "Magnesium chloride",
    "Pogostemon cablin",
    "Citrus sinensis",
    "Simmondsia chinensis",
    "Cocos nucifera",
    "Melaleuca alternifolia",
    "Eucalyptus globulus",
    "Mentha piperita",
    "Pelargonium graveolens",
    "Cedrus atlantica",
    "Eugenia caryophyllus",
    "Cinnamomum zeylanicum",
    "Rosmarinus officinalis"
  ];

  /* Dictionaries are one file per language now (assets/js/locales/<code>.js),
     fetched the first time somebody reads the shop in that language, and they
     register themselves into this registry. locales-data.js creates it and
     carries only the glossary and the manifest.

     Under Node -- the unit suite, and anything else that requires this file
     directly -- there is no document to append a script to, so the loader
     falls back to require() into this object. */
  var nodeRegistry = {};
  /* Bumped by every setLanguage() call. A switch that finishes fetching after
     a LATER switch has already been asked for must not apply itself: clicking
     Español and then 한국어 while Spanish is still in flight used to end with
     the page in Spanish, the badge on ES, and "es" persisted -- whichever
     dictionary happened to arrive last won, rather than whichever the shopper
     asked for last. */
  var languageRequestSeq = 0;
  /* One promise per code while its file is in flight, so eight simultaneous
     asks make one request. A FAILED load is deleted rather than remembered:
     a dropped connection must not permanently poison a language. */
  var localeLoads = {};

  /**
   * Retrieve the dictionary registry from global or the Node fallback.
   */
  function getLocales() {
    if (typeof window !== "undefined" && window.YL_LOCALES) return window.YL_LOCALES;
    if (typeof global !== "undefined" && global.YL_LOCALES) return global.YL_LOCALES;
    return nodeRegistry;
  }

  /** True when this code's phrases are in hand. */
  function hasLocale(code) {
    var locales = getLocales();
    return !!(locales && locales[code] && locales[code].phrases);
  }

  /* How long to wait for one dictionary before giving up and staying English.
     Generous, because the alternative to waiting is a page that says ES and
     reads English -- the exact failure the 2026-09-02 audit found. */
  var LOCALE_FETCH_TIMEOUT_MS = 10000;

  /**
   * Make sure one language's dictionary is loaded. Resolves true/false; never
   * rejects, because every caller's answer to a failure is the same: stay in
   * English.
   */
  function ensureLocale(code) {
    if (!code || hasLocale(code)) return Promise.resolve(true);
    var known = LANGUAGES.some(function (l) {
      return l.code === code;
    });
    if (!known) return Promise.resolve(false);

    if (typeof document === "undefined" || !document.createElement) {
      /* Node: require it straight in. */
      try {
        // eslint-disable-next-line global-require
        var doc = require("./locales/" + code + ".js");
        if (doc && doc.phrases) {
          nodeRegistry[code] = doc;
          return Promise.resolve(true);
        }
      } catch {
        // fall through to false
      }
      return Promise.resolve(false);
    }

    if (localeLoads[code]) return localeLoads[code];
    localeLoads[code] = new Promise(function (resolve) {
      var settled = false;
      var timer = null;
      function finish() {
        if (settled) return;
        settled = true;
        if (timer !== null) {
          try {
            clearTimeout(timer);
          } catch {
            // ignore
          }
        }
        /* The OUTCOME is whether the dictionary registered itself -- not
           whether the tag fired load. A script whose body throws a
           SyntaxError fires `load`, not `error`, and any 200 that is not
           valid JS gets here: a branded error shell, a truncated response out
           of the service-worker cache, a captive-portal interstitial. Keying
           the memo off `load` meant such a page kept a permanently-false
           promise for this locale and every later attempt returned it without
           retrying -- the shopper clicks Español, gets nothing, clicks again
           on a working connection, and still gets nothing. Only a real
           registration is remembered. */
        const registered = hasLocale(code);
        if (!registered) delete localeLoads[code];
        resolve(registered);
      }
      var script = document.createElement("script");
      script.src = "/assets/js/locales/" + code + ".js?v=2.0";
      /* Ordered execution, same reason main.js sets it: these are appended
         dynamically, which makes them force-async unless told otherwise. */
      script.async = false;
      script.onload = finish;
      script.onerror = finish;
      if (typeof setTimeout === "function") {
        timer = setTimeout(function () {
          /* Give up waiting, but leave the tag alone: it may still land, and
             removing it here would make a retry append a second request for
             the same URL. finish() re-reads the registry either way. */
          finish();
        }, LOCALE_FETCH_TIMEOUT_MS);
      }
      (document.head || document.body || document.documentElement).appendChild(script);
    });
    return localeLoads[code];
  }

  /**
   * The English index AND the target dictionary, in parallel. English is not
   * optional: every lookup starts by matching a node's text against en.
   */
  /* The unit suite substitutes a loader it can hold back, to prove the
     switch race below is handled. Null means "use the real one". */
  var ensureLocaleOverride = null;
  function ensureLocalesFor(code) {
    if (code === "en") return Promise.resolve(true);
    var load = ensureLocaleOverride || ensureLocale;
    return Promise.all([load("en"), load(code)]).then(function (results) {
      return results[0] && results[1];
    });
  }

  /**
   * Retrieve compiled brand glossary from global or require.
   */
  function getGlossary() {
    if (typeof window !== "undefined" && window.YL_BRAND_GLOSSARY) return window.YL_BRAND_GLOSSARY;
    if (typeof global !== "undefined" && global.YL_BRAND_GLOSSARY) return global.YL_BRAND_GLOSSARY;
    try {
      // eslint-disable-next-line global-require
      var data = require("./locales-data.js");
      return data.BRAND_GLOSSARY || data.YL_BRAND_GLOSSARY || {};
    } catch {
      return {};
    }
  }

  /**
   * Normalize whitespace for robust string matching.
   */
  function normalizeText(str) {
    if (!str || typeof str !== "string") return "";
    return str.replace(/\s+/g, " ").trim();
  }

  /**
   * Build lookup index mapping English text and phrases to i18n keys.
   */
  function buildLookupIndices() {
    englishPhraseToKey = {};
    normalizedPhraseToKey = {};
    glossaryTermsSet = new Set(FALLBACK_PROTECTED_TERMS);

    var glossary = getGlossary();
    if (glossary) {
      if (Array.isArray(glossary.protectedTerms)) {
        glossary.protectedTerms.forEach(function (t) {
          glossaryTermsSet.add(t);
        });
      }
      if (glossary.categories) {
        for (var cat in glossary.categories) {
          if (Array.isArray(glossary.categories[cat])) {
            glossary.categories[cat].forEach(function (t) {
              glossaryTermsSet.add(t);
            });
          }
        }
      }
    }

    var locales = getLocales();
    var en = locales && locales.en ? locales.en.phrases : null;
    if (en) {
      for (var key in en) {
        var val = en[key];
        if (typeof val === "string") {
          englishPhraseToKey[val] = key;
          englishPhraseToKey[val.trim()] = key;
          normalizedPhraseToKey[normalizeText(val)] = key;
        }
      }
    }
  }

  /**
   * Check if a given string is a protected brand or botanical term.
   */
  function isProtectedTerm(term) {
    if (!term || typeof term !== "string") return false;
    var trimmed = term.trim();
    if (!trimmed) return false;

    if (!glossaryTermsSet) {
      buildLookupIndices();
    }
    return glossaryTermsSet.has(trimmed);
  }

  /**
   * Look up translation for a specific i18n key.
   */
  function lookupByKey(key, targetLang) {
    if (!key || typeof key !== "string") return null;
    var locales = getLocales();
    if (!locales) return null;

    if (locales[targetLang] && locales[targetLang].phrases && locales[targetLang].phrases[key]) {
      return locales[targetLang].phrases[key];
    }
    if (locales.en && locales.en.phrases && locales.en.phrases[key]) {
      return locales.en.phrases[key];
    }
    return null;
  }

  /**
   * Look up translation for an English phrase string.
   */
  function lookupPhrase(phrase, targetLang) {
    if (!phrase || typeof phrase !== "string") return phrase;
    var trimmed = phrase.trim();
    if (!trimmed || targetLang === "en") return phrase;

    if (isProtectedTerm(trimmed)) {
      return phrase;
    }

    if (!englishPhraseToKey || Object.keys(englishPhraseToKey).length === 0) {
      buildLookupIndices();
    }

    var locales = getLocales();
    if (!locales) return phrase;

    // 1. Direct dictionary key match
    if (
      locales[targetLang] &&
      locales[targetLang].phrases &&
      locales[targetLang].phrases[trimmed]
    ) {
      return locales[targetLang].phrases[trimmed];
    }

    // 2. Inverted English phrase lookup
    var key = englishPhraseToKey[trimmed] || normalizedPhraseToKey[normalizeText(trimmed)];
    if (key) {
      var translated = lookupByKey(key, targetLang);
      if (translated) return translated;
    }

    // 3. Fallback: check if target phrases has direct match for original phrase
    if (locales[targetLang] && locales[targetLang].phrases && locales[targetLang].phrases[phrase]) {
      return locales[targetLang].phrases[phrase];
    }

    return phrase;
  }

  /**
   * Fill {name} placeholders in a template string with `vars[name]`.
   *
   * Every substituted value is run back through lookupPhrase() at the same
   * target language before it lands in the string. That is what lets one
   * template mechanism serve both kinds of variable this dictionary needs
   * to carry: a value that is ALSO a dictionary phrase (a category name
   * like "Body & Skin") comes back translated, while a value that is not --
   * a product name (protected by the brand glossary), a dollar amount, a
   * bare count -- comes back unchanged, because lookupPhrase() has nothing
   * to match it against. No separate "translate this var / don't translate
   * that one" flag is needed; the dictionary already knows which is which.
   *
   * A placeholder with no matching var is left as the literal "{name}"
   * rather than silently disappearing, so a wiring mistake is visible on
   * the page instead of vanishing into an empty string.
   */
  function renderTemplate(str, vars, targetLang) {
    if (typeof str !== "string" || !str) return str;
    if (!vars || typeof vars !== "object") return str;
    return str.replace(/\{(\w+)\}/g, function (match, name) {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) return match;
      var raw = vars[name];
      if (raw === null || raw === undefined) return match;
      var value = String(raw);
      return targetLang && targetLang !== "en" ? lookupPhrase(value, targetLang) : value;
    });
  }

  /**
   * Translate-and-fill a template dictionary key ("tpl.*") -- the
   * composition-time half of the template mechanism described at the top of
   * this file. Falls back to the English template when the target locale
   * has none (including when no locale is loaded at all yet), and to the
   * bare key when English has none either, so a bad key fails loud -- an
   * odd "tpl.foo" showing up on the page -- rather than throwing or
   * quietly returning nothing.
   *
   * Exposed on window as YL_T so composition sites (gift-card.js, main.js)
   * can call it directly instead of concatenating a string the whole-node
   * matcher in translateNode() could never reach.
   */
  function t(key, vars, targetLang) {
    var lang = targetLang || currentLang;
    var template = lookupByKey(key, lang);
    if (!template) return key;
    return renderTemplate(template, vars, lang);
  }

  /**
   * Parse an element's data-i18n-vars attribute (a JSON object literal) for
   * use with t()/renderTemplate(). Malformed or absent JSON is treated the
   * same as "no vars" rather than thrown.
   */
  function parseI18nVars(node) {
    if (!node || typeof node.getAttribute !== "function") return null;
    var raw = node.getAttribute("data-i18n-vars");
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Check if an element should be skipped during translation traversal.
   */
  function shouldSkipElement(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName ? el.tagName.toUpperCase() : "";
    if (
      tag === "SCRIPT" ||
      tag === "STYLE" ||
      tag === "NOSCRIPT" ||
      tag === "CODE" ||
      tag === "PRE" ||
      tag === "TEMPLATE"
    ) {
      return true;
    }
    if (el.id === "langSelectorWrap" || el.id === "tawk-chat-container") {
      return true;
    }
    if (typeof el.getAttribute === "function" && el.getAttribute("translate") === "no") {
      return true;
    }
    if (el.classList) {
      if (
        el.classList.contains("notranslate") ||
        el.classList.contains("skiptranslate") ||
        el.classList.contains("brand") ||
        el.classList.contains("brand-word") ||
        el.classList.contains("lang-selector-wrap") ||
        el.classList.contains("lang-dropdown") ||
        el.classList.contains("lang-toggle")
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if any ancestor of a node is marked to be skipped.
   */
  function isInsideSkippedElement(node) {
    var curr = node.nodeType === 1 ? node : node.parentNode;
    while (curr && curr !== document.body && curr !== document.documentElement) {
      if (shouldSkipElement(curr)) return true;
      curr = curr.parentNode;
    }
    return false;
  }

  /**
   * Note that one of an element's own text nodes was, or was not, replaced.
   *
   * Language marking is per-element and not per-text-node because `lang` is an
   * HTML attribute and text nodes cannot carry one. Protected terms (brand
   * names, INCI botanicals) are counted as NEITHER: they are proper nouns that
   * read the same in every locale, so letting them count as a miss would stop
   * a fully translated heading from being marked.
   */
  function noteLang(el, wasTranslated) {
    if (!el || el.nodeType !== 1 || !langHits || !langMisses) return;
    var bucket = wasTranslated ? langHits : langMisses;
    bucket.set(el, (bucket.get(el) || 0) + 1);
  }

  /**
   * Stamp a lang attribute on an element, remembering what was there before.
   */
  function markLang(el, langCode) {
    if (!el || typeof el.setAttribute !== "function") return;
    if (el.__ylOriginalLang === undefined) {
      el.__ylOriginalLang = typeof el.getAttribute === "function" ? el.getAttribute("lang") : null;
    }
    if (!el.__ylLangMarked) {
      el.__ylLangMarked = true;
      langMarkedElements.push(el);
    }
    el.setAttribute("lang", langCode);
  }

  /**
   * Undo every lang attribute this engine has stamped.
   */
  function clearLangMarks() {
    for (var i = 0; i < langMarkedElements.length; i++) {
      var el = langMarkedElements[i];
      if (!el || typeof el.setAttribute !== "function") continue;
      if (el.__ylOriginalLang === null || el.__ylOriginalLang === undefined) {
        if (typeof el.removeAttribute === "function") el.removeAttribute("lang");
      } else {
        el.setAttribute("lang", el.__ylOriginalLang);
      }
      el.__ylLangMarked = false;
      el.__ylOriginalLang = undefined;
    }
    langMarkedElements.length = 0;
  }

  /**
   * Mark the elements this pass actually translated -- and only those.
   *
   * WHY THIS IS NOT `<html lang="es">`. The obvious implementation sets the
   * language on the document element. That is only honest when the document is
   * in that language. Dictionary coverage here is 10-20% of the text nodes on
   * a page (audit 2026-09-02 S3), so `<html lang="es">` told every screen
   * reader to apply Spanish phonetics to the 80-90% of the page that is still
   * English -- WCAG 2.1 SC 3.1.1 Language of Page, Level A, and strictly worse
   * for a blind visitor than leaving the document in English. So the document
   * stays `lang="en"` and the mark goes on the elements whose text was
   * genuinely replaced. Raise coverage and this scales with it for free; if it
   * ever reaches the whole page, revisit the document-level attribute then.
   *
   * Two rules:
   *   - An element is marked only when EVERY one of its own text nodes was
   *     replaced. Mixed English/Spanish inside one element cannot be described
   *     by a single attribute, so it is left alone rather than described
   *     wrongly.
   *   - An element still holding English text underneath something we just
   *     marked is stamped `lang="en"`, because it would otherwise inherit the
   *     new language from that ancestor.
   *
   * Attributes are deliberately out of scope: a translated aria-label on an
   * element whose text is English has no per-attribute language in HTML, and
   * marking the element for it would mispronounce the text.
   */
  function applyLangMarks(targetLang) {
    if (!langHits || !langMisses || targetLang === "en") return;

    langHits.forEach(function (count, el) {
      if (!count) return;
      if (langMisses.get(el)) return;
      markLang(el, targetLang);
    });

    langMisses.forEach(function (count, el) {
      if (!count || typeof el.closest !== "function") return;
      var nearest = el.closest("[lang]");
      if (nearest && nearest !== el && nearest.__ylLangMarked) {
        markLang(el, "en");
      }
    });
  }

  /**
   * Translate a single node (text node or element attributes/data-i18n).
   */
  function translateNode(node, targetLang) {
    if (!node) return;

    // Handle Text Nodes
    if (
      node.nodeType === 3 ||
      node.nodeType === (typeof Node !== "undefined" ? Node.TEXT_NODE : 3)
    ) {
      if (isInsideSkippedElement(node)) return;

      if (node.__ylOriginalText === undefined) {
        node.__ylOriginalText = node.nodeValue !== null ? node.nodeValue : "";
      }

      if (targetLang === "en") {
        node.nodeValue = node.__ylOriginalText;
        return;
      }

      var raw = node.__ylOriginalText;
      var trimmed = raw.trim();
      if (!trimmed || isProtectedTerm(trimmed)) {
        return;
      }

      var textParent = node.parentNode && node.parentNode.nodeType === 1 ? node.parentNode : null;
      var translated = lookupPhrase(trimmed, targetLang);
      /* Compared against the node's CURRENT value, not against the cached
         English. Those are the same thing on a first switch and they are not
         the same thing on a second one: German's "Shop" IS "Shop", so
         `translated !== trimmed` was false and the node was left holding
         whatever the PREVIOUS language had written into it. Switching
         es -> de left "Tienda" and "Preguntas frecuentes" sitting in a German
         nav, unmarked, so a screen reader read them in an English voice
         (6 stale nodes on the homepage, 20 on shop.html; audit 2026-09-04).

         It became reachable in one click rather than two the day the initial
         language started being DETECTED: a shopper on a Spanish phone who
         opens the picker once is exactly the audience this engine is for. */
      if (translated) {
        var leadingMatch = raw.match(/^(\s*)/);
        var trailingMatch = raw.match(/(\s*)$/);
        var leading = leadingMatch ? leadingMatch[1] : "";
        var trailing = trailingMatch ? trailingMatch[1] : "";
        var next = leading + translated + trailing;
        if (node.nodeValue !== next) node.nodeValue = next;
        /* Marked only when the text actually differs from the English, which
           is what <html lang="en"> already covers -- a German "Shop" needs no
           lang="de" and would only add noise for a screen reader. */
        noteLang(textParent, translated !== trimmed);
      } else {
        noteLang(textParent, false);
      }
      return;
    }

    // Handle Element Nodes
    if (
      node.nodeType === 1 ||
      node.nodeType === (typeof Node !== "undefined" ? Node.ELEMENT_NODE : 1)
    ) {
      if (shouldSkipElement(node)) return;

      // 1. data-i18n explicit key translation
      if (typeof node.hasAttribute === "function" && node.hasAttribute("data-i18n")) {
        var key = node.getAttribute("data-i18n");
        if (node.__ylOriginalText === undefined) {
          node.__ylOriginalText = node.textContent !== null ? node.textContent : "";
        }
        if (targetLang === "en") {
          var enText = lookupByKey(key, "en");
          node.textContent = enText || node.__ylOriginalText;
        } else {
          var transText = lookupByKey(key, targetLang);
          if (transText) {
            node.textContent = transText;
            noteLang(node, true);
            /* Assigning textContent DESTROYS the old text node and creates a
               new one -- a childList mutation. The MutationObserver receives
               that record a microtask later, by which time the isTranslating
               guard set in setLanguage() has already been cleared by its
               synchronous finally block, so the observer translates the new
               node and caches its TRANSLATED value as __ylOriginalText. The
               switch back to English then restores it to the translation and
               the string is stuck in the target language forever.

               Seed the cache with the real English original so the observer
               finds it already populated and leaves it alone. Currently
               unreachable -- nothing in the shipped markup carries data-i18n
               -- but adopting data-i18n is the obvious fix for the coverage
               gap, and this path is where it lands. */
            var seeded = node.childNodes && node.childNodes[0];
            if (seeded && seeded.nodeType === 3) {
              seeded.__ylOriginalText = lookupByKey(key, "en") || node.__ylOriginalText || "";
            }
          }
        }
      }

      /* 1b. data-i18n-tpl explicit TEMPLATE translation -- the runtime half
         of the mechanism described at the top of this file. Where data-i18n
         (above) points at a fixed dictionary phrase, data-i18n-tpl points at
         a "tpl.*" phrase containing {placeholders}, filled in from the
         sibling data-i18n-vars JSON attribute via t(). This is how a string
         JS or the build assembled with a variable in the middle -- "Write a
         review of Sleep Salve", "Step 2: Body & Skin" -- gets translated at
         all: the whole-node text matcher above can never match it, because
         no single English phrase equals every product's or category's
         version of it. */
      if (typeof node.hasAttribute === "function" && node.hasAttribute("data-i18n-tpl")) {
        var tplKey = node.getAttribute("data-i18n-tpl");
        if (node.__ylOriginalText === undefined) {
          node.__ylOriginalText = node.textContent !== null ? node.textContent : "";
        }
        if (targetLang === "en") {
          node.textContent = node.__ylOriginalText;
        } else {
          var tplText = t(tplKey, parseI18nVars(node), targetLang);
          if (tplText && tplText !== tplKey) {
            node.textContent = tplText;
            noteLang(node, true);
            // Same MutationObserver race as the data-i18n seed above.
            var seededTpl = node.childNodes && node.childNodes[0];
            if (seededTpl && seededTpl.nodeType === 3) {
              seededTpl.__ylOriginalText = node.__ylOriginalText;
            }
          }
        }
      }

      // 2. Placeholder attribute
      var hasPlaceholder =
        typeof node.hasAttribute === "function"
          ? node.hasAttribute("placeholder")
          : node.placeholder !== undefined;
      if (hasPlaceholder) {
        if (node.__ylOriginalPlaceholder === undefined) {
          node.__ylOriginalPlaceholder =
            (typeof node.getAttribute === "function" && node.getAttribute("placeholder")) ||
            node.placeholder ||
            "";
        }
        if (node.__ylOriginalPlaceholder) {
          if (targetLang === "en") {
            if (typeof node.setAttribute === "function") {
              node.setAttribute("placeholder", node.__ylOriginalPlaceholder);
            }
            node.placeholder = node.__ylOriginalPlaceholder;
          } else {
            var pTplKey = node.getAttribute("data-i18n-tpl-placeholder");
            var pKey =
              typeof node.getAttribute === "function"
                ? node.getAttribute("data-i18n-placeholder")
                : null;
            var pTrans = pTplKey
              ? t(pTplKey, parseI18nVars(node), targetLang)
              : pKey
                ? lookupByKey(pKey, targetLang)
                : lookupPhrase(node.__ylOriginalPlaceholder.trim(), targetLang);
            /* t() answers with the KEY when nothing resolves. The text branch
               above refuses that; these three wrote "tpl.whatever" straight
               into the attribute -- heard only by a screen-reader user, which
               is the worst place to be silently wrong (audit 2026-09-04). */
            if (pTrans && pTrans !== pTplKey) {
              if (typeof node.setAttribute === "function") {
                node.setAttribute("placeholder", pTrans);
              }
              node.placeholder = pTrans;
            }
          }
        }
      }

      // 3. Aria-label attribute
      if (typeof node.hasAttribute === "function" && node.hasAttribute("aria-label")) {
        if (node.__ylOriginalAriaLabel === undefined) {
          node.__ylOriginalAriaLabel = node.getAttribute("aria-label") || "";
        }
        if (node.__ylOriginalAriaLabel) {
          if (targetLang === "en") {
            node.setAttribute("aria-label", node.__ylOriginalAriaLabel);
          } else {
            var aTplKey = node.getAttribute("data-i18n-tpl-aria-label");
            var aKey = node.getAttribute("data-i18n-aria-label");
            var aTrans = aTplKey
              ? t(aTplKey, parseI18nVars(node), targetLang)
              : aKey
                ? lookupByKey(aKey, targetLang)
                : lookupPhrase(node.__ylOriginalAriaLabel.trim(), targetLang);
            if (aTrans && aTrans !== aTplKey) {
              node.setAttribute("aria-label", aTrans);
            }
          }
        }
      }

      // 4. Title attribute
      if (typeof node.hasAttribute === "function" && node.hasAttribute("title")) {
        if (node.__ylOriginalTitle === undefined) {
          node.__ylOriginalTitle = node.getAttribute("title") || "";
        }
        if (node.__ylOriginalTitle) {
          if (targetLang === "en") {
            node.setAttribute("title", node.__ylOriginalTitle);
          } else {
            var tTplKey = node.getAttribute("data-i18n-tpl-title");
            var tKey = node.getAttribute("data-i18n-title");
            var tTrans = tTplKey
              ? t(tTplKey, parseI18nVars(node), targetLang)
              : tKey
                ? lookupByKey(tKey, targetLang)
                : lookupPhrase(node.__ylOriginalTitle.trim(), targetLang);
            if (tTrans && tTrans !== tTplKey) {
              node.setAttribute("title", tTrans);
            }
          }
        }
      }
    }
  }

  /**
   * Recursively walk and translate all child nodes of an element.
   */
  function walkChildren(node, targetLang) {
    if (!node) return;
    if (node.nodeType === 1 && shouldSkipElement(node)) return;

    translateNode(node, targetLang);

    if (node.childNodes && node.childNodes.length > 0) {
      for (var i = 0; i < node.childNodes.length; i++) {
        walkChildren(node.childNodes[i], targetLang);
      }
    } else if (node._children && node._children.length > 0) {
      for (var j = 0; j < node._children.length; j++) {
        walkChildren(node._children[j], targetLang);
      }
    }
  }

  /**
   * Translate an entire DOM subtree rooted at rootEl.
   */
  function translateTree(rootEl, targetLang) {
    if (!rootEl) return;

    /* Per-call bookkeeping for applyLangMarks(). The MutationObserver calls
       this once per added subtree, so it has to be scoped to the call, not to
       the language switch. */
    langHits = typeof Map === "function" ? new Map() : null;
    langMisses = typeof Map === "function" ? new Map() : null;

    // Check if translating root document
    if (
      typeof document !== "undefined" &&
      (rootEl === document || rootEl === document.body || rootEl === document.documentElement)
    ) {
      if (document.__ylOriginalTitle === undefined) {
        document.__ylOriginalTitle = document.title || "";
      }
      if (document.__ylOriginalTitle) {
        if (targetLang === "en") {
          document.title = document.__ylOriginalTitle;
        } else {
          var titleTrans = lookupPhrase(document.__ylOriginalTitle.trim(), targetLang);
          if (titleTrans) {
            document.title = titleTrans;
          }
        }
      }
    }

    // Fast TreeWalker traversal where available
    if (
      typeof document !== "undefined" &&
      typeof document.createTreeWalker === "function" &&
      typeof NodeFilter !== "undefined" &&
      rootEl.nodeType === 1
    ) {
      translateNode(rootEl, targetLang);
      if (shouldSkipElement(rootEl)) return;

      var walker = document.createTreeWalker(
        rootEl,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        {
          acceptNode: function (n) {
            if (n.nodeType === 1 && shouldSkipElement(n)) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      var currNode;
      while ((currNode = walker.nextNode())) {
        translateNode(currNode, targetLang);
      }
    } else {
      walkChildren(rootEl, targetLang);
    }

    applyLangMarks(targetLang);
  }

  /**
   * Set up MutationObserver to automatically translate dynamically added elements.
   */
  function initMutationObserver() {
    if (
      observer ||
      typeof MutationObserver === "undefined" ||
      typeof document === "undefined" ||
      !document.body
    ) {
      return;
    }

    observer = new MutationObserver(function (mutations) {
      if (isTranslating || currentLang === "en") return;

      var addedNodesList = [];
      for (var i = 0; i < mutations.length; i++) {
        var mut = mutations[i];
        if (mut.type === "childList" && mut.addedNodes) {
          for (var j = 0; j < mut.addedNodes.length; j++) {
            var added = mut.addedNodes[j];
            if (added.nodeType === 1 || added.nodeType === 3) {
              addedNodesList.push(added);
            }
          }
        }
      }

      if (addedNodesList.length > 0) {
        isTranslating = true;
        try {
          for (var k = 0; k < addedNodesList.length; k++) {
            translateTree(addedNodesList[k], currentLang);
          }
        } finally {
          isTranslating = false;
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  /**
   * Human-readable name for a language code, for accessible names.
   */
  function languageName(code) {
    for (var i = 0; i < LANGUAGES.length; i++) {
      if (LANGUAGES[i].code === code) return LANGUAGES[i].name;
    }
    return code;
  }

  /**
   * The toggle button's accessible name.
   *
   * It used to be the bare "Select language", which OVERRODE the visible "EN"
   * badge -- so a screen-reader user could operate the control but could not
   * tell which language was active, the one piece of state the button exists
   * to show (audit 2026-09-02 S4). Naming the current language fixes that
   * without changing the visible chrome.
   */
  function toggleLabelFor(code) {
    return "Select language, current language " + languageName(code);
  }

  /**
   * Update active CSS class and ARIA states in language dropdown.
   */
  function updateUIState(langCode) {
    if (typeof document === "undefined") return;

    var buttons = document.querySelectorAll(".lang-option");
    if (buttons && buttons.length) {
      buttons.forEach(function (btn) {
        var isSelected = btn.getAttribute("data-lang") === langCode;
        if (isSelected) {
          btn.classList.add("active");
          btn.setAttribute("aria-selected", "true");
        } else {
          btn.classList.remove("active");
          btn.setAttribute("aria-selected", "false");
        }
      });
    }

    var indicator = document.querySelector(".lang-current-code");
    if (indicator) {
      indicator.textContent = langCode.toUpperCase();
    }

    var toggle = document.querySelector(".lang-toggle");
    if (toggle && typeof toggle.setAttribute === "function") {
      toggle.setAttribute("aria-label", toggleLabelFor(langCode));
    }
  }

  /**
   * Master language switcher function.
   */
  async function setLanguage(langCode, options) {
    var valid = LANGUAGES.some(function (l) {
      return l.code === langCode;
    });
    var target = valid ? langCode : "en";
    var prevLang = currentLang;
    var persist = !(options && options.persist === false);

    /* Fetch first, claim second. The dictionary for `target` is its own file
       now, so this is the point where a page can find out it cannot actually
       render the language it was asked for -- a dead connection, a 404 after
       a bad deploy, a shopper offline in a language they have never used.
       Every one of those has the same right answer: stay in English. Flipping
       the badge to ES over an English page is the failure this whole engine
       was rewritten to stop doing. */
    const requestId = ++languageRequestSeq;
    if (target !== "en" && !(await ensureLocalesFor(target))) {
      /* Nothing changes: the page keeps the language it is already rendered
         in. A shopper reading in Japanese who asks for Vietnamese offline
         keeps their Japanese page rather than being dropped back to English
         for a language they did not ask to leave.

         The RETURN VALUE is the language now in effect, not the one that was
         asked for, because every caller uses it to decide what to believe --
         init() compares it against what it requested, and the UI badge
         follows it. Returning "en" here would have been a second lie in the
         family this engine exists to avoid: it would have said English while
         the page was Japanese. */
      return currentLang;
    }

    /* Somebody asked for a different language while this one was fetching.
       Theirs is the answer the shopper is waiting for; drop this one rather
       than repainting the page out from under it. */
    if (requestId !== languageRequestSeq) return currentLang;

    currentLang = target;

    /* The document element's lang is deliberately NOT changed -- see
       applyLangMarks(). The page's content language is still English; only the
       elements this engine actually replaced get marked, and they get marked
       during the walk below.

       dir IS still a document-level property: it describes layout, not
       pronunciation, and a page whose text is 80-90% English must not be laid
       out right-to-left on the strength of a partial translation. Every locale
       that ships today declares "ltr", so this is a no-op; the day an RTL
       locale is added, it needs the same per-element treatment lang has. */
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.setAttribute("dir", "ltr");
    }

    /* Update the stored preference -- unless this language was DETECTED
       rather than chosen (see getInitialLanguage). Writing a guess into
       storage would turn it into a decision: the shopper who later sets their
       phone to English would keep getting Spanish, from a key they never
       asked for and cannot see. */
    if (persist) {
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.setItem("yl-lang", target);
        }
      } catch {
        // ignore storage quota / security errors
      }
    }

    // Update UI controls
    updateUIState(target);

    // Perform DOM in-place translation
    isTranslating = true;
    try {
      /* Marks from the previous language are meaningless under the new one:
         a string that had an es entry may have no ja entry. Drop them all and
         let this pass re-earn each one. */
      clearLangMarks();
      if (typeof document !== "undefined" && document.body) {
        translateTree(document.body, target);
      }
    } finally {
      isTranslating = false;
    }

    // Dispatch custom event for external subscribers
    if (typeof document !== "undefined" && typeof document.dispatchEvent === "function") {
      var event;
      if (typeof CustomEvent === "function") {
        event = new CustomEvent("yl-language-changed", {
          detail: { lang: target, prevLang: prevLang }
        });
      } else if (typeof document.createEvent === "function") {
        event = document.createEvent("CustomEvent");
        if (typeof event.initCustomEvent === "function") {
          event.initCustomEvent("yl-language-changed", true, true, {
            lang: target,
            prevLang: prevLang
          });
        }
      }
      if (event) {
        document.dispatchEvent(event);
      }
    }

    // Analytics event
    if (
      typeof window !== "undefined" &&
      typeof window.plausible === "function" &&
      prevLang !== target
    ) {
      window.plausible("Language Changed", { props: { language: target } });
    }

    return target;
  }

  /**
   * Inject accessible language switcher into header navigation.
   */
  function initUI() {
    if (typeof document === "undefined") return;
    var navCta = document.querySelector(".nav-cta");
    if (!navCta || document.getElementById("langSelectorWrap")) return;

    var wrap = document.createElement("div");
    wrap.className = "lang-selector-wrap notranslate";
    wrap.id = "langSelectorWrap";

    // Toggle button
    var toggleBtn = document.createElement("button");
    toggleBtn.className = "lang-toggle";
    toggleBtn.type = "button";
    toggleBtn.setAttribute("aria-label", toggleLabelFor(currentLang));
    toggleBtn.setAttribute("aria-expanded", "false");
    toggleBtn.setAttribute("aria-haspopup", "listbox");
    /* Names the listbox this button expands, which aria-haspopup on its own
       does not. Must match dropdown.id below. */
    toggleBtn.setAttribute("aria-controls", "langDropdown");
    toggleBtn.innerHTML =
      globeSVG + '<span class="lang-current-code">' + currentLang.toUpperCase() + "</span>";

    // Dropdown list
    var dropdown = document.createElement("div");
    dropdown.className = "lang-dropdown";
    dropdown.id = "langDropdown";
    dropdown.setAttribute("role", "listbox");
    dropdown.setAttribute("aria-label", "Select language");

    var optionButtons = [];

    LANGUAGES.forEach(function (lang) {
      var btn = document.createElement("button");
      btn.className = "lang-option" + (lang.code === currentLang ? " active" : "");
      btn.type = "button";
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", lang.code === currentLang ? "true" : "false");
      btn.setAttribute("data-lang", lang.code);
      btn.textContent = lang.name;

      btn.addEventListener("click", async function () {
        var code = btn.getAttribute("data-lang");
        dropdown.classList.remove("open");
        toggleBtn.setAttribute("aria-expanded", "false");
        await setLanguage(code);
        toggleBtn.focus();
      });

      dropdown.appendChild(btn);
      optionButtons.push(btn);
    });

    wrap.appendChild(toggleBtn);
    wrap.appendChild(dropdown);

    // Insert before theme toggle if present, otherwise append
    var themeToggle = document.getElementById("themeToggle");
    if (themeToggle && themeToggle.parentNode === navCta) {
      navCta.insertBefore(wrap, themeToggle);
    } else {
      navCta.appendChild(wrap);
    }

    // Toggle dropdown open/close on click
    toggleBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = dropdown.classList.toggle("open");
      toggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open && optionButtons.length > 0) {
        var activeBtn = dropdown.querySelector(".lang-option.active") || optionButtons[0];
        if (activeBtn && typeof activeBtn.focus === "function") {
          activeBtn.focus();
        }
      }
    });

    // Toggle button keyboard navigation (Enter, Space, ArrowDown, ArrowUp)
    toggleBtn.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        dropdown.classList.add("open");
        toggleBtn.setAttribute("aria-expanded", "true");
        var activeBtn = dropdown.querySelector(".lang-option.active") || optionButtons[0];
        if (activeBtn && typeof activeBtn.focus === "function") {
          activeBtn.focus();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        dropdown.classList.add("open");
        toggleBtn.setAttribute("aria-expanded", "true");
        var lastBtn = optionButtons[optionButtons.length - 1];
        if (lastBtn && typeof lastBtn.focus === "function") {
          lastBtn.focus();
        }
      }
    });

    // Dropdown list keyboard navigation
    dropdown.addEventListener("keydown", function (e) {
      var currentFocus = document.activeElement;
      var currentIndex = optionButtons.indexOf(currentFocus);

      if (e.key === "ArrowDown") {
        e.preventDefault();
        var nextIndex = currentIndex < optionButtons.length - 1 ? currentIndex + 1 : 0;
        optionButtons[nextIndex].focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        var prevIndex = currentIndex > 0 ? currentIndex - 1 : optionButtons.length - 1;
        optionButtons[prevIndex].focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        if (optionButtons.length > 0) optionButtons[0].focus();
      } else if (e.key === "End") {
        e.preventDefault();
        if (optionButtons.length > 0) optionButtons[optionButtons.length - 1].focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        dropdown.classList.remove("open");
        toggleBtn.setAttribute("aria-expanded", "false");
        toggleBtn.focus();
      } else if (e.key === "Tab") {
        dropdown.classList.remove("open");
        toggleBtn.setAttribute("aria-expanded", "false");
      }
    });

    // Close dropdown on outside click
    document.addEventListener("click", function (e) {
      if (!wrap.contains(e.target)) {
        dropdown.classList.remove("open");
        toggleBtn.setAttribute("aria-expanded", "false");
      }
    });
  }

  /**
   * Determine initial language preference from URL param or localStorage.
   */
  /**
   * The best dictionary we have for the browser's own language preference,
   * or null.
   *
   * `navigator.languages` is an ORDERED list -- ["es-MX", "en-US"] means this
   * reader prefers Spanish and will accept English -- so the first entry with
   * a dictionary wins, and a list that leads with any English tag resolves to
   * English exactly as it should.
   *
   * Region subtags are dropped, which is the right answer for every language
   * this shop ships: es.json IS Latin American Spanish and pt.json IS
   * Brazilian, so es-MX, es-419, pt-BR and pt-PT all land where they should.
   * The one imperfect case is zh-TW / zh-HK, whose readers get the Simplified
   * dictionary -- closer to their language than English is, and the shop has
   * no Traditional dictionary to offer them.
   */
  function detectBrowserLanguage() {
    var tags = [];
    try {
      if (typeof navigator !== "undefined" && navigator) {
        if (navigator.languages && navigator.languages.length) {
          tags = Array.prototype.slice.call(navigator.languages);
        } else if (navigator.language) {
          tags = [navigator.language];
        }
      }
    } catch {
      return null;
    }
    for (var i = 0; i < tags.length; i++) {
      var base = String(tags[i] || "")
        .toLowerCase()
        .split("-")[0]
        .trim();
      if (!base) continue;
      var matched = LANGUAGES.some(function (l) {
        return l.code === base;
      });
      if (matched) return base;
    }
    return null;
  }

  function getInitialLanguage() {
    return getInitialLanguageSource().lang;
  }

  /**
   * The initial language AND where it came from: "url", "stored", "browser"
   * or "default". init() needs the source, because a detected language must
   * not be written to storage the way a chosen one is.
   */
  function getInitialLanguageSource() {
    var langFromUrl = null;
    if (typeof window !== "undefined" && window.location && window.location.search) {
      try {
        var params = new URLSearchParams(window.location.search);
        langFromUrl = params.get("lang");
      } catch {
        // ignore malformed query params
      }
    }

    if (
      langFromUrl &&
      LANGUAGES.some(function (l) {
        return l.code === langFromUrl.toLowerCase();
      })
    ) {
      return { lang: langFromUrl.toLowerCase(), source: "url" };
    }

    var saved = null;
    try {
      if (typeof localStorage !== "undefined") {
        saved = localStorage.getItem("yl-lang");
      }
    } catch {
      // ignore
    }

    if (
      saved &&
      LANGUAGES.some(function (l) {
        return l.code === saved.toLowerCase();
      })
    ) {
      return { lang: saved.toLowerCase(), source: "stored" };
    }

    /* Nothing chosen and nothing stored: read the shop in the language the
       device is already set to. A shopper whose phone is in Vietnamese should
       not have to find a globe icon to be spoken to in Vietnamese.

       Order matters and it is the order above: an explicit ?lang= wins over a
       stored choice, and a stored choice wins over the browser. Once yl-lang
       holds anything it is the shopper's own decision -- including a
       deliberate switch back to English on a Spanish-language phone, which is
       a real and common preference and must never be overridden by a detector.

       Nothing is written to storage here on purpose: an auto-detected
       language stays auto-detected, so a shopper who changes their device
       language later gets the shop in the new one rather than being pinned to
       a guess this page made once. */
    var detected = detectBrowserLanguage();
    if (detected) return { lang: detected, source: "browser" };

    return { lang: "en", source: "default" };
  }

  /**
   * Are the compiled dictionaries actually here?
   *
   * getLocales() answers {} rather than throwing when locales-data.js has not
   * executed yet, so "we have a locales object" is not the same question as
   * "we can translate anything". This asserts the subject exists: an English
   * index to look phrases up in, and at least one non-English locale to
   * translate them into. buildLookupIndices() over an empty object produces
   * empty indices and every lookup then silently returns its input.
   *
   * @return {boolean}
   */
  function localesReady() {
    var locales = getLocales();
    if (!locales || !locales.en || !locales.en.phrases) return false;
    for (var code in locales) {
      if (code !== "en" && locales[code] && locales[code].phrases) return true;
    }
    return false;
  }

  /* How often, and for how long, to keep looking for late dictionaries. 50ms x
     100 = 5s, which covers a slow 3G fetch of the 71KB locales-data.js with
     room to spare; after that we stop rather than spin forever. */
  var LOCALES_WATCH_INTERVAL_MS = 50;
  var LOCALES_WATCH_MAX_ATTEMPTS = 100;

  /**
   * Re-run init() once the dictionaries arrive.
   *
   * assets/js/main.js appends locales-data.js before translator.js with
   * .async = false, so in the shipped page this never fires. It exists because
   * "translator.js executed first and therefore this page is permanently
   * untranslated" was a silent, unrecoverable state (audit 2026-09-02 S4), and
   * a page that loads these two files some other way -- a test harness, a
   * future partial hydration, a stale service-worker entry -- must not be able
   * to re-enter it. init() is idempotent: initUI() returns early when
   * #langSelectorWrap exists, initMutationObserver() returns early when the
   * observer is live, and buildLookupIndices() simply rebuilds.
   *
   * Costs nothing in the normal case: only armed when a non-English language
   * was asked for AND the dictionaries were missing at init time.
   */
  function waitForLocales() {
    if (pendingLocalesWatch !== null || typeof setTimeout !== "function") return;
    var attempts = 0;
    function tick() {
      attempts++;
      if (localesReady()) {
        pendingLocalesWatch = null;
        init();
        return;
      }
      if (attempts >= LOCALES_WATCH_MAX_ATTEMPTS) {
        pendingLocalesWatch = null;
        return;
      }
      pendingLocalesWatch = setTimeout(tick, LOCALES_WATCH_INTERVAL_MS);
    }
    pendingLocalesWatch = setTimeout(tick, LOCALES_WATCH_INTERVAL_MS);
  }

  /**
   * Initialize localization engine and UI.
   *
   * Safe to call more than once -- see waitForLocales().
   */
  async function init() {
    buildLookupIndices();
    var initial = getInitialLanguageSource();
    var lang = initial.lang;
    /* Start English and let setLanguage() promote the page once it has the
       dictionary in hand. Claiming the language up front would put the badge
       on ES for as long as the fetch takes, and permanently if it fails --
       the picker showing a language the page is not written in, which is the
       one thing this engine must never do. */
    currentLang = "en";

    initUI();
    initMutationObserver();
    updateUIState("en");

    if (lang !== "en") {
      /* setLanguage fetches the dictionary itself and returns "en" if it
         cannot get it, so the old "translate against nothing" hazard is gone
         from this path: there is no window in which the badge says ES and the
         dictionary is absent. What survives from that fix is the recovery
         watcher below, for a page that had its dictionaries taken away or
         supplied some other way. */
      /* Neither a DETECTED language nor a ?lang= link is a decision the
         shopper made about this browser, so neither is written to storage.

         Detection: writing a guess would turn it into a decision they never
         made and cannot see, and changing their phone's language would then
         stop changing the shop.

         ?lang=: PROJECT.md calls it "overridable per-visit" and cart.test.js
         says it changes the page "without rewriting storage" -- but the code
         persisted it, so a shared /?lang=de link permanently overwrote the
         recipient's OWN stored choice. Two statements of intent against one
         line of code; the line was wrong. A visitor who follows a link and
         then wants to keep that language has the picker, which does persist. */
      var applied = await setLanguage(lang, { persist: initial.source === "stored" });
      if (applied !== lang) {
        /* Could not fetch it. The page is honest -- English badge, English
           copy -- and the watcher below covers the case where the
           dictionaries turn up by some other route. */
        waitForLocales();
      }
    }
  }

  // Public Translation API
  var YL_TRANSLATOR = {
    LANGUAGES: LANGUAGES,
    getCurrentLanguage: function () {
      return currentLang;
    },
    setLanguage: setLanguage,
    translateTree: translateTree,
    translateNode: translateNode,
    isProtectedTerm: isProtectedTerm,
    lookupPhrase: lookupPhrase,
    lookupByKey: lookupByKey,
    t: t,
    renderTemplate: renderTemplate,
    getInitialLanguage: getInitialLanguage,
    getInitialLanguageSource: getInitialLanguageSource,
    detectBrowserLanguage: detectBrowserLanguage,
    ensureLocale: ensureLocale,
    _setEnsureLocaleForTest: function (fn) {
      ensureLocaleOverride = typeof fn === "function" ? fn : null;
    },
    initUI: initUI,
    init: init,
    _getInternalState: function () {
      return {
        currentLang: currentLang,
        observer: observer,
        isTranslating: isTranslating
      };
    },
    _resetInternalState: function () {
      currentLang = "en";
      isTranslating = false;
      clearLangMarks();
      if (pendingLocalesWatch !== null) {
        try {
          clearTimeout(pendingLocalesWatch);
        } catch {
          // ignore
        }
        pendingLocalesWatch = null;
      }
      englishPhraseToKey = null;
      normalizedPhraseToKey = null;
      glossaryTermsSet = null;
      if (observer) {
        try {
          observer.disconnect();
        } catch {
          // ignore
        }
        observer = null;
      }
    }
  };

  // Attach to window object
  if (typeof window !== "undefined") {
    window.YL_TRANSLATOR = YL_TRANSLATOR;
    /* Composition-time half of the template mechanism (see file header):
       code that builds a string with a variable in the middle -- an amount,
       a count, a product name -- calls this instead of concatenating, so
       switching language re-renders it correctly instead of leaving it
       permanently in whatever language was active when it was first typed. */
    window.YL_T = t;
  }

  // Support CommonJS exports for unit testing
  if (typeof module !== "undefined" && module.exports) {
    module.exports = YL_TRANSLATOR;
  }

  /* Auto-initialize on DOM ready -- deliberately the LAST thing this file
     does. translator.js is fetched asynchronously (see the file's opening
     comment on load order), so by the time it runs, document.readyState is
     almost always already past "loading" and init() fires right here -- ASYNC
     since the dictionaries went on demand (2026-09-04): for a non-English
     initial language the dispatchEvent inside setLanguage() lands one fetch
     later, not synchronously -- and what still has to hold is the ordering
     that follows,
     right here, including the dispatchEvent("yl-language-changed") inside
     setLanguage() for the page's initial language. A composition site
     (gift-card.js) that listens for that event to render its initial state
     needs window.YL_T to already exist at that moment -- this used to run
     BEFORE the "Attach to window object" block above, so the very first
     dispatch always fired with window.YL_T still undefined, and the page's
     first paint of the gift button stayed English until the shopper touched
     something (verified live: shop.html?lang=es). */
  if (typeof document !== "undefined") {
    if (document.readyState !== "loading") {
      init();
    } else {
      document.addEventListener("DOMContentLoaded", init);
    }
  }
})();
