/* ==========================================================
   Y'ALLTERNATIVE LIVING | Automated Multi-Language Translator
   ----------------------------------------------------------
   Resilient SOTA browser translation featuring Chrome's built-in
   on-device Translator API (where available) with a custom-styled,
   in-place Google Translate widget fallback for Safari/Firefox/Mobile.
   ========================================================== */
(function () {
  "use strict";

  var LANGUAGES = [
    { code: "en", name: "English", flag: "🇺🇸" },
    { code: "es", name: "Español", flag: "🇲🇽" },
    { code: "de", name: "Deutsch", flag: "🇩🇪" },
    { code: "fr", name: "Français", flag: "🇨🇦" },
    { code: "ja", name: "日本語", flag: "🇯🇵" },
    { code: "zh", name: "中文", flag: "🇨🇳" }
  ];

  var globeSVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="icon-globe">' +
    '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>' +
    '<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>' +
    "</svg>";

  var currentLang = "en";
  var nativeTranslator = null;
  var isGoogleLoaded = false;
  var googleInitPromise = null;
  var observer = null;

  // Resilient check for Chrome/Edge Built-in Translation API
  var chromeTranslationNamespace = null;
  if (typeof self !== "undefined") {
    if (self.translation && typeof self.translation.createTranslator === "function") {
      chromeTranslationNamespace = self.translation;
    } else if (self.ai && self.ai.translator && typeof self.ai.translator.create === "function") {
      chromeTranslationNamespace = self.ai.translator;
    }
  }

  // Check if a language pair is natively supported on-device
  async function checkNativeSupport(target) {
    if (!chromeTranslationNamespace) return "no";
    try {
      var options = { sourceLanguage: "en", targetLanguage: target };
      if (typeof chromeTranslationNamespace.canTranslate === "function") {
        return await chromeTranslationNamespace.canTranslate(options);
      }
      if (typeof chromeTranslationNamespace.availability === "function") {
        return await chromeTranslationNamespace.availability(options);
      }
    } catch (e) {
      console.warn("[translator] Native support check failed:", e);
    }
    return "no";
  }

  // Instantiate native translator
  async function getNativeTranslator(target) {
    if (!chromeTranslationNamespace) return null;
    var options = { sourceLanguage: "en", targetLanguage: target };
    try {
      if (typeof chromeTranslationNamespace.createTranslator === "function") {
        return await chromeTranslationNamespace.createTranslator(options);
      }
      if (typeof chromeTranslationNamespace.create === "function") {
        return await chromeTranslationNamespace.create(options);
      }
    } catch (e) {
      console.error("[translator] Native translator creation failed:", e);
    }
    return null;
  }

  // Load Google Translate script dynamically (fallback)
  function loadGoogleScript() {
    if (googleInitPromise) return googleInitPromise;

    googleInitPromise = new Promise(function (resolve) {
      // 1. Create hidden element for Google Translate widget
      if (!document.getElementById("google_translate_element")) {
        var el = document.createElement("div");
        el.id = "google_translate_element";
        el.style.display = "none";
        document.body.appendChild(el);
      }

      // 2. Define callback function
      window.googleTranslateElementInit = function () {
        new window.google.translate.TranslateElement(
          {
            pageLanguage: "en",
            autoDisplay: false
          },
          "google_translate_element"
        );
        isGoogleLoaded = true;
        resolve();
      };

      // 3. Inject script
      var s = document.createElement("script");
      s.id = "google_translate_script";
      s.src = "https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit";
      s.async = true;
      document.body.appendChild(s);
    });

    return googleInitPromise;
  }

  // Trigger Google Translate widget to translate in-place without page reload
  function triggerGoogleTranslate(langCode, retries) {
    retries = retries || 0;
    if (retries > 50) {
      console.warn("[translator] Google Translate widget timed out loading.");
      return;
    }
    var selectEl = document.querySelector(".goog-te-combo");
    if (selectEl) {
      // Google Translate's combobox expects empty string or 'en' to reset to English
      var targetVal = langCode === "en" ? "" : langCode;
      if (selectEl.value !== targetVal) {
        selectEl.value = targetVal;
        selectEl.dispatchEvent(new Event("change"));
      }
    } else {
      // If combo box is not generated yet, try again shortly
      setTimeout(function () {
        triggerGoogleTranslate(langCode, retries + 1);
      }, 100);
    }
  }

  // Walker to traverse DOM and translate text nodes natively
  async function translateNatively(translatorInstance) {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var parent = node.parentNode;
        if (!parent) return NodeFilter.FILTER_REJECT;
        var tag = parent.tagName.toLowerCase();
        if (
          tag === "script" ||
          tag === "style" ||
          tag === "noscript" ||
          tag === "code" ||
          tag === "pre"
        ) {
          return NodeFilter.FILTER_REJECT;
        }

        // Avoid translating interactive widgets, checkout elements, or skipped text
        var curr = parent;
        while (curr) {
          if (curr.id === "snipcart" || curr.id === "tawk-chat-container") {
            return NodeFilter.FILTER_REJECT;
          }
          if (curr.classList && (
            curr.classList.contains("skiptranslate") ||
            curr.classList.contains("snipcart-checkout") ||
            Array.from(curr.classList).some(function (c) {
              return c.startsWith("snipcart-") || c.startsWith("tawk-");
            })
          )) {
            return NodeFilter.FILTER_REJECT;
          }
          curr = curr.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    var textNodes = [];
    var node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }

    // Cache and translate text nodes in batches of 15
    var batchSize = 15;
    for (var i = 0; i < textNodes.length; i += batchSize) {
      var chunk = textNodes.slice(i, i + batchSize);
      await Promise.all(
        chunk.map(async function (node) {
          var original = node.__originalText !== undefined ? node.__originalText : node.nodeValue;
          if (node.__originalText === undefined) {
            node.__originalText = node.nodeValue;
          }
          try {
            var translated = await translatorInstance.translate(original);
            node.nodeValue = translated;
          } catch (e) {
            console.warn("[translator] Error translating node:", original, e);
          }
        })
      );
    }

    // Translate Document Title
    if (document.__originalTitle === undefined) {
      document.__originalTitle = document.title;
    }
    try {
      document.title = await translatorInstance.translate(document.__originalTitle);
    } catch (e) {
      console.warn("[translator] Error translating document title:", e);
    }

    // Translate Placeholders
    var inputs = document.querySelectorAll("input[placeholder], textarea[placeholder]");
    inputs.forEach(async function (input) {
      var original = input.__originalPlaceholder !== undefined ? input.__originalPlaceholder : input.placeholder;
      if (input.__originalPlaceholder === undefined) {
        input.__originalPlaceholder = input.placeholder;
      }
      try {
        input.placeholder = await translatorInstance.translate(original);
      } catch (e) {
        console.warn("[translator] Error translating placeholder:", original, e);
      }
    });
  }

  // Restore cached English content
  function restoreOriginalEnglish() {
    // 1. Restore text nodes
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (node.__originalText !== undefined) {
        node.nodeValue = node.__originalText;
      }
    }

    // 2. Restore document title
    if (document.__originalTitle !== undefined) {
      document.title = document.__originalTitle;
    }

    // 3. Restore placeholders
    var inputs = document.querySelectorAll("input[placeholder], textarea[placeholder]");
    inputs.forEach(function (input) {
      if (input.__originalPlaceholder !== undefined) {
        input.placeholder = input.__originalPlaceholder;
      }
    });
  }

  // Master translation handler
  async function performTranslation(target) {
    if (target === "en") {
      // Restore English natively if we used native translator
      if (nativeTranslator) {
        restoreOriginalEnglish();
        nativeTranslator = null;
      }
      // Reset Google Translate widget if loaded
      if (isGoogleLoaded) {
        triggerGoogleTranslate("en");
      }
      return;
    }

    // 1. Try Native on-device Translator API
    var nativeSupport = await checkNativeSupport(target);
    if (nativeSupport === "readily" || nativeSupport === "available") {
      var translator = await getNativeTranslator(target);
      if (translator) {
        nativeTranslator = translator;
        await translateNatively(translator);
        return;
      }
    }

    // 2. Fallback to Google Translate widget
    await loadGoogleScript();
    triggerGoogleTranslate(target);
  }

  // Update active UI states
  function updateActiveState(langCode) {
    var buttons = document.querySelectorAll(".lang-option");
    buttons.forEach(function (btn) {
      if (btn.getAttribute("data-lang") === langCode) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });

    // Update localStorage
    try {
      localStorage.setItem("yl-lang", langCode);
    } catch (e) {
      // ignore
    }

    currentLang = langCode;
  }

  // Create language switcher UI and inject it into the nav bar
  function initUI() {
    var navCta = document.querySelector(".nav-cta");
    if (!navCta || document.getElementById("langSelectorWrap")) return;

    var wrap = document.createElement("div");
    wrap.className = "lang-selector-wrap";
    wrap.id = "langSelectorWrap";

    // Toggle button
    var toggleBtn = document.createElement("button");
    toggleBtn.className = "lang-toggle";
    toggleBtn.type = "button";
    toggleBtn.setAttribute("aria-label", "Select language");
    toggleBtn.setAttribute("aria-expanded", "false");
    toggleBtn.innerHTML = globeSVG;

    // Dropdown list
    var dropdown = document.createElement("div");
    dropdown.className = "lang-dropdown";
    dropdown.id = "langDropdown";

    LANGUAGES.forEach(function (lang) {
      var btn = document.createElement("button");
      btn.className = "lang-option" + (lang.code === currentLang ? " active" : "");
      btn.type = "button";
      btn.setAttribute("data-lang", lang.code);
      btn.innerHTML = '<span class="flag">' + lang.flag + "</span> " + lang.name;

      btn.addEventListener("click", async function () {
        var code = btn.getAttribute("data-lang");
        dropdown.classList.remove("open");
        toggleBtn.setAttribute("aria-expanded", "false");
        updateActiveState(code);
        await performTranslation(code);
      });

      dropdown.appendChild(btn);
    });

    wrap.appendChild(toggleBtn);
    wrap.appendChild(dropdown);

    // Insert before the theme toggle if it exists, otherwise append
    var themeToggle = document.getElementById("themeToggle");
    if (themeToggle) {
      navCta.insertBefore(wrap, themeToggle);
    } else {
      navCta.appendChild(wrap);
    }

    // Toggle behavior
    toggleBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = dropdown.classList.toggle("open");
      toggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });

    // Close on outside click
    document.addEventListener("click", function (e) {
      if (!wrap.contains(e.target)) {
        dropdown.classList.remove("open");
        toggleBtn.setAttribute("aria-expanded", "false");
      }
    });

    // Close on escape key
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && dropdown.classList.contains("open")) {
        dropdown.classList.remove("open");
        toggleBtn.setAttribute("aria-expanded", "false");
        toggleBtn.focus();
      }
    });
  }

  // Determine initial language on load (check localStorage, then browser preference)
  async function getInitialLanguage() {
    var saved = null;
    try {
      saved = localStorage.getItem("yl-lang");
    } catch (e) {
      // ignore
    }

    if (saved && LANGUAGES.some(function (l) { return l.code === saved; })) {
      return saved;
    }

    // Fallback to browser preference
    if (navigator.language) {
      var pref = navigator.language.split("-")[0];
      if (LANGUAGES.some(function (l) { return l.code === pref; })) {
        return pref;
      }
    }

    return "en";
  }

  // MutationObserver to translate dynamically loaded elements (e.g. filtered shop cards)
  function initMutationObserver() {
    if (observer || typeof MutationObserver === "undefined") return;
    observer = new MutationObserver(function (mutations) {
      if (!nativeTranslator) return;
      
      var nodesToTranslate = [];
      mutations.forEach(function (mutation) {
        if (mutation.type === "childList") {
          mutation.addedNodes.forEach(function (node) {
            findTextNodes(node, nodesToTranslate);
          });
        }
      });

      if (nodesToTranslate.length > 0) {
        translateTextNodesNatively(nodesToTranslate, nativeTranslator);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function findTextNodes(node, list) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue.trim() && node.__originalText === undefined) {
        var parent = node.parentNode;
        if (parent) {
          var tag = parent.tagName.toLowerCase();
          if (tag !== "script" && tag !== "style" && tag !== "noscript" && tag !== "code" && tag !== "pre") {
            var curr = parent;
            var skip = false;
            while (curr) {
              if (curr.id === "snipcart" || curr.id === "tawk-chat-container") {
                skip = true;
                break;
              }
              if (curr.classList && (
                curr.classList.contains("skiptranslate") ||
                curr.classList.contains("snipcart-checkout") ||
                Array.from(curr.classList).some(function (c) {
                  return c.startsWith("snipcart-") || c.startsWith("tawk-");
                })
              )) {
                skip = true;
                break;
              }
              curr = curr.parentNode;
            }
            if (!skip) list.push(node);
          }
        }
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.id === "snipcart" || node.id === "tawk-chat-container") return;
      if (node.classList && (
        node.classList.contains("skiptranslate") ||
        node.classList.contains("snipcart-checkout") ||
        Array.from(node.classList).some(function (c) {
          return c.startsWith("snipcart-") || c.startsWith("tawk-");
        })
      )) return;
      
      node.childNodes.forEach(function (child) {
        findTextNodes(child, list);
      });
    }
  }

  async function translateTextNodesNatively(textNodes, translatorInstance) {
    var batchSize = 15;
    for (var i = 0; i < textNodes.length; i += batchSize) {
      var chunk = textNodes.slice(i, i + batchSize);
      await Promise.all(
        chunk.map(async function (node) {
          var original = node.nodeValue;
          node.__originalText = original;
          try {
            var translated = await translatorInstance.translate(original);
            if (node.nodeValue === original) {
              node.nodeValue = translated;
            }
          } catch (e) {
            console.warn("[translator] Observer translation error:", original, e);
          }
        })
      );
    }
  }

  // Initialization function
  async function init() {
    var lang = await getInitialLanguage();
    currentLang = lang;

    // Inject UI controls
    initUI();
    initMutationObserver();
    updateActiveState(lang);

    // If initial language is not English, execute translation
    if (lang !== "en") {
      await performTranslation(lang);
    }
  }

  // Run on DOMContentLoaded or immediately if ready
  if (document.readyState !== "loading") {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
