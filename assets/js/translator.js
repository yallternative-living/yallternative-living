/* ==========================================================
   Y'ALLTERNATIVE LIVING | Self-Hosted Client-Side Localization Engine
   ----------------------------------------------------------
   Lightweight, zero-external-dependency, cookieless translation engine.
   Translates text nodes, data-i18n elements, placeholders, and aria-labels
   in-place using compiled locale dictionaries and brand glossary rules.
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
    { code: "zh", name: "中文" }
  ];

  var globeSVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="icon-globe" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>' +
    '<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>' +
    "</svg>";

  var currentLang = "en";
  var observer = null;
  var isTranslating = false;

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

  /**
   * Retrieve compiled locales dictionary from global or require.
   */
  function getLocales() {
    if (typeof window !== "undefined" && window.YL_LOCALES) return window.YL_LOCALES;
    if (typeof global !== "undefined" && global.YL_LOCALES) return global.YL_LOCALES;
    try {
      // eslint-disable-next-line global-require
      var data = require("./locales-data.js");
      return data.LOCALES || data.YL_LOCALES || {};
    } catch {
      return {};
    }
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

      var translated = lookupPhrase(trimmed, targetLang);
      if (translated && translated !== trimmed) {
        var leadingMatch = raw.match(/^(\s*)/);
        var trailingMatch = raw.match(/(\s*)$/);
        var leading = leadingMatch ? leadingMatch[1] : "";
        var trailing = trailingMatch ? trailingMatch[1] : "";
        node.nodeValue = leading + translated + trailing;
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
            var pKey =
              typeof node.getAttribute === "function"
                ? node.getAttribute("data-i18n-placeholder")
                : null;
            var pTrans = pKey
              ? lookupByKey(pKey, targetLang)
              : lookupPhrase(node.__ylOriginalPlaceholder.trim(), targetLang);
            if (pTrans) {
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
            var aKey = node.getAttribute("data-i18n-aria-label");
            var aTrans = aKey
              ? lookupByKey(aKey, targetLang)
              : lookupPhrase(node.__ylOriginalAriaLabel.trim(), targetLang);
            if (aTrans) {
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
            var tKey = node.getAttribute("data-i18n-title");
            var tTrans = tKey
              ? lookupByKey(tKey, targetLang)
              : lookupPhrase(node.__ylOriginalTitle.trim(), targetLang);
            if (tTrans) {
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
  }

  /**
   * Master language switcher function.
   */
  async function setLanguage(langCode) {
    var valid = LANGUAGES.some(function (l) {
      return l.code === langCode;
    });
    var target = valid ? langCode : "en";
    var prevLang = currentLang;

    currentLang = target;

    // Update document lang & dir attributes
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.setAttribute("lang", target);
      var locales = getLocales();
      if (locales && locales[target] && locales[target].meta && locales[target].meta.dir) {
        document.documentElement.setAttribute("dir", locales[target].meta.dir);
      } else {
        document.documentElement.setAttribute("dir", "ltr");
      }
    }

    // Update local storage preference
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("yl-lang", target);
      }
    } catch {
      // ignore storage quota / security errors
    }

    // Update UI controls
    updateUIState(target);

    // Perform DOM in-place translation
    isTranslating = true;
    try {
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
    toggleBtn.setAttribute("aria-label", "Select language");
    toggleBtn.setAttribute("aria-expanded", "false");
    toggleBtn.setAttribute("aria-haspopup", "listbox");
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
  function getInitialLanguage() {
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
      return langFromUrl.toLowerCase();
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
      return saved.toLowerCase();
    }

    return "en";
  }

  /**
   * Initialize localization engine and UI.
   */
  async function init() {
    buildLookupIndices();
    var lang = getInitialLanguage();
    currentLang = lang;

    initUI();
    initMutationObserver();
    updateUIState(lang);

    if (lang !== "en") {
      await setLanguage(lang);
    }
  }

  // Auto-initialize on DOM ready
  if (typeof document !== "undefined") {
    if (document.readyState !== "loading") {
      init();
    } else {
      document.addEventListener("DOMContentLoaded", init);
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
    getInitialLanguage: getInitialLanguage,
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
  }

  // Support CommonJS exports for unit testing
  if (typeof module !== "undefined" && module.exports) {
    module.exports = YL_TRANSLATOR;
  }
})();
