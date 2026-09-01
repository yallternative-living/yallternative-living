/* ==========================================================
   Y'ALLTERNATIVE LIVING | on-site cart -> Stripe Checkout
   Zero dependencies, vanilla JS. Self-contained on-site cart +
   drawer that hands off to Stripe Checkout via the Cloudflare
   Worker in workers/checkout.js. Self-initializes on load (see
   the bottom of this file) -- just include this script on a page,
   nothing else to wire up.

   The cart reads the same data-item-* attributes the Add to Cart
   buttons already carry (a holdover naming convention from the
   Snipcart era this replaced -- see docs/STRIPE-MIGRATION.md),
   so the button markup didn't have to change for the cart to work.
   ========================================================== */
/* global module */
(function (root) {
  "use strict";

  var STORAGE_KEY = "yl-cart-v1";
  var CHECKOUT_URL = "/api/checkout"; // Cloudflare Worker route (workers/checkout.js)
  var DEFAULT_FREE_SHIP = 40; // products.json shop.freeShippingThreshold
  var MAX_QTY = 99;
  var GIFT_CARD_ID = "yallternative-gift-card";

  /* ---------------- Pure cart math (unit-testable in Node) ---------------- */

  // A line's identity = product id + chosen variant label, so "Tank Top / M"
  // and "Tank Top / L" are separate lines that merge/add independently.
  //
  // Gift cards are the one exception: two gift cards at the same dollar
  // amount must NOT merge into one qty-2 line, because each one can carry a
  // different recipient email/sender/message. item.lineId (assigned once,
  // at add-time, see newLineId() below) keeps every gift card its own line
  // regardless of amount.
  function lineKey(item) {
    if (item.id === GIFT_CARD_ID) {
      return item.id + "|" + (item.lineId || item.variantLabel || "");
    }
    /* Two custom boxes with different contents are different lines, so key on
       the contents. Same shape of problem as gift cards, where two cards for
       different recipients mustn't merge into a quantity of 2. */
    if (item.id === "custom-box") {
      return item.id + "|" + (item.boxProductIds || []).join(",");
    }
    return item.id + "|" + (item.variantLabel || "");
  }

  // Parse Snipcart-style custom-field options ("M[+0.00]|L[+2.00]") and return
  // the price delta for a chosen label. Keeps the cart reading the exact same
  // attribute the buttons already emit.
  function deltaForLabel(optionsStr, label) {
    if (!optionsStr || !label) return 0;
    var parts = optionsStr.split("|");
    for (var i = 0; i < parts.length; i++) {
      var m = parts[i].match(/^(.*)\[([+-])([0-9.]+)\]$/);
      if (m && m[1] === label) {
        var val = parseFloat(m[3]) || 0;
        return m[2] === "-" ? -val : val;
      }
    }
    return 0;
  }

  // cap: an optional per-product ceiling (from data-item-max-quantity, a
  // real stock count -- see main.js's addToCartHTML()), always additionally
  // bounded by the cart's own hard MAX_QTY.
  function clampQty(n, cap) {
    var q = parseInt(n, 10);
    if (isNaN(q) || q < 1) return 1;
    var ceiling = cap && cap > 0 ? Math.min(cap, MAX_QTY) : MAX_QTY;
    if (q > ceiling) return ceiling;
    return q;
  }

  var QUALIFYING_2OZ_SALVE_PRICE = 14.99;

  var DEFAULT_VOLUME_PRICING = [
    {
      id: "salves-2oz",
      name: "2oz Salve Multi-Buy",
      category: "salves",
      qualifyingVariant: "2oz",
      minQuantity: 2,
      unitPrice: QUALIFYING_2OZ_SALVE_PRICE,
      label: "2+ for $14.99 each",
      enabled: true
    }
  ];

  function getCatalog() {
    if (typeof root !== "undefined" && root && root.YL_PRODUCTS) return root.YL_PRODUCTS;
    if (typeof window !== "undefined" && window && window.YL_PRODUCTS) return window.YL_PRODUCTS;
    var g = typeof globalThis !== "undefined" ? globalThis : null;
    if (g && g.window && g.window.YL_PRODUCTS) return g.window.YL_PRODUCTS;
    if (g && g.YL_PRODUCTS) return g.YL_PRODUCTS;
    return null;
  }

  function getVolumePricingRules() {
    var cat = getCatalog();
    if (cat && Array.isArray(cat.volumePricing)) {
      return cat.volumePricing.filter(function (r) {
        return r && r.enabled !== false;
      });
    }
    if (cat && cat.shop && Array.isArray(cat.shop.volumePricing)) {
      return cat.shop.volumePricing.filter(function (r) {
        return r && r.enabled !== false;
      });
    }
    return DEFAULT_VOLUME_PRICING;
  }

  function getItemCategory(item) {
    if (!item || !item.id) return "";
    var cat = "";
    var catalog = getCatalog();
    if (catalog && Array.isArray(catalog.products)) {
      var found = catalog.products.find(function (p) {
        return p && p.id === item.id;
      });
      if (found && found.category) cat = found.category;
    }
    if (!cat && item.category) {
      cat = item.category;
    }
    if (!cat && (item.id === "frankincense-salve" || item.id === "sleep-salve")) {
      cat = "salves";
    }
    return cat;
  }

  function itemMatchesRule(item, rule) {
    if (!item || !item.id || !rule || rule.enabled === false) return false;
    var cat = getItemCategory(item);
    if (cat !== rule.category) return false;

    if (rule.qualifyingVariant) {
      var normQ = String(rule.qualifyingVariant).trim().toLowerCase().replace(/\s+/g, "");
      var v = item.variantLabel || item.variant;
      if (v) {
        var normV = String(v).trim().toLowerCase().replace(/\s+/g, "");
        return normV === normQ;
      }
      var id = String(item.id);
      if (id === "miracle-balm") return false;
      if (id === "sleep-salve") return true;

      var catalog = getCatalog();
      var entry = null;
      if (catalog && Array.isArray(catalog.products)) {
        entry = catalog.products.find(function (p) {
          return p && p.id === item.id;
        });
      }
      if (entry) {
        if (
          entry.variants &&
          Array.isArray(entry.variants.options) &&
          entry.variants.options.length > 0
        ) {
          return false;
        }
        var text = (
          String(entry.name || "") +
          " " +
          String(entry.blurb || "") +
          " " +
          String(entry.description || "")
        )
          .toLowerCase()
          .replace(/\s+/g, "");
        return text.indexOf(normQ) !== -1;
      }
      return false;
    }
    return true;
  }

  function ruleQualifyingCount(rule, items) {
    if (!Array.isArray(items) || !rule) return 0;
    return items.reduce(function (sum, it) {
      return sum + (itemMatchesRule(it, rule) ? Number(it.qty) || 1 : 0);
    }, 0);
  }

  function isQualifying2ozSalve(item) {
    var rules = getVolumePricingRules();
    var salveRule =
      rules.find(function (r) {
        return r.category === "salves";
      }) || DEFAULT_VOLUME_PRICING[0];
    return itemMatchesRule(item, salveRule);
  }

  function qualifying2ozSalveCount(items) {
    var rules = getVolumePricingRules();
    var salveRule =
      rules.find(function (r) {
        return r.category === "salves";
      }) || DEFAULT_VOLUME_PRICING[0];
    return ruleQualifyingCount(salveRule, items);
  }

  function getActiveRuleForItem(item, items) {
    var rules = getVolumePricingRules();
    var matchedRule = null;
    var lowestPrice = null;
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (itemMatchesRule(item, r)) {
        var count = Array.isArray(items)
          ? ruleQualifyingCount(r, items)
          : item && item.qty
            ? item.qty
            : 1;
        var minQ = typeof r.minQuantity === "number" ? r.minQuantity : 2;
        if (count >= minQ) {
          var price = Number(r.unitPrice);
          if (lowestPrice === null || price < lowestPrice) {
            lowestPrice = price;
            matchedRule = r;
          }
        }
      }
    }
    return matchedRule;
  }

  function unitPrice(item, items) {
    var base =
      Math.round(Math.max(0, (Number(item.price) || 0) + (Number(item.variantDelta) || 0)) * 100) /
      100;
    var activeRule = getActiveRuleForItem(item, items);
    if (activeRule && typeof activeRule.unitPrice === "number") {
      return Math.min(base, activeRule.unitPrice);
    }
    return base;
  }

  function subtotal(items) {
    var raw = (items || []).reduce(function (sum, it) {
      return sum + unitPrice(it, items) * it.qty;
    }, 0);
    return Math.round(raw * 100) / 100;
  }

  function totalCount(items) {
    return (items || []).reduce(function (n, it) {
      return n + it.qty;
    }, 0);
  }

  // Merge a new item into the list (same line -> bump qty, capped).
  function addToList(items, item) {
    var list = items.slice();
    var key = lineKey(item);
    var found = null;
    for (var i = 0; i < list.length; i++) {
      if (lineKey(list[i]) === key) {
        found = list[i];
        break;
      }
    }
    if (found) {
      found.qty = clampQty(found.qty + item.qty, item.maxQty || found.maxQty);
      // A later add can supply a fresher maxQty (e.g. stock was updated
      // between page loads); keep whichever is present.
      if (item.maxQty) found.maxQty = item.maxQty;
    } else {
      item.qty = clampQty(item.qty, item.maxQty);
      list.push(item);
    }
    return list;
  }

  // The exact payload shape workers/checkout.js validates. Gift-card lines
  // additionally carry recipient/sender/message so the Worker can attach
  // them to the Stripe session as metadata -- never as anything that
  // affects price (price for gift cards is derived server-side from the
  // The exact payload shape workers/checkout.js validates. Gift-card lines
  // additionally carry recipient/sender/message so the Worker can attach
  // them to the Stripe session as metadata -- never as anything that
  // affects price (price for gift cards is derived server-side from the
  // "Preset $NN" variant label alone, see workers/checkout.js).
  function toCheckoutPayload(items, pickupMarket, giftCardCode, isGiftOrder, giftMessage) {
    var payload = {
      items: (items || []).map(function (it) {
        var o = { id: it.id, qty: it.qty };
        if (it.variantLabel) o.variant = it.variantLabel;
        /* A build-your-own box carries its contents rather than a variant --
           the Worker re-prices it from these ids against products.json and the
           shop's customBox rules, so the amount the client thinks it costs is
           never trusted (see resolveCustomBoxCents in workers/checkout.js). */
        if (it.id === "custom-box" && Array.isArray(it.boxProductIds)) {
          o.boxProductIds = it.boxProductIds.slice();
        }
        if (it.id === GIFT_CARD_ID) {
          if (it.giftRecipientEmail) o.giftRecipientEmail = it.giftRecipientEmail;
          if (it.giftSenderName) o.giftSenderName = it.giftSenderName;
          if (it.giftMessage) o.giftMessage = it.giftMessage;
        }
        return o;
      })
    };
    if (pickupMarket) {
      payload.pickupMarket = pickupMarket;
      payload.pickup_market = pickupMarket;
    }
    if (giftCardCode && typeof giftCardCode === "string") {
      var cleanCode = giftCardCode.trim().toUpperCase();
      payload.giftCardCode = cleanCode;
      payload.gift_card_code = cleanCode;
    }
    if (isGiftOrder) {
      payload.isGiftOrder = true;
      payload.is_gift_order = true;
      if (giftMessage) {
        var cleanMsg = String(giftMessage).slice(0, 500);
        payload.giftMessage = cleanMsg;
        payload.gift_message = cleanMsg;
      }
    }
    return payload;
  }

  /* ---------------- Dispatch Status calculation (Landrum, SC 2 PM ET cutoff) ---------------- */

  function getPostalHolidays(year) {
    var holidays = {};
    function add(y, m, d) {
      var mm = m < 10 ? "0" + m : "" + m;
      var dd = d < 10 ? "0" + d : "" + d;
      holidays[y + "-" + mm + "-" + dd] = true;
    }
    function addObserved(y, m, d) {
      var dt = new Date(Date.UTC(y, m - 1, d));
      var day = dt.getUTCDay();
      if (day === 0) {
        var next = new Date(Date.UTC(y, m - 1, d + 1));
        add(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
      } else if (day === 6) {
        var prev = new Date(Date.UTC(y, m - 1, d - 1));
        add(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate());
      } else {
        add(y, m, d);
      }
    }
    function getNthWeekdayOfMonth(y, m, weekday, n) {
      var count = 0;
      for (var d = 1; d <= 31; d++) {
        var dt = new Date(Date.UTC(y, m - 1, d));
        if (dt.getUTCMonth() !== m - 1) break;
        if (dt.getUTCDay() === weekday) {
          count++;
          if (count === n) return d;
        }
      }
      return 1;
    }
    function getLastWeekdayOfMonth(y, m, weekday) {
      var last = 1;
      for (var d = 1; d <= 31; d++) {
        var dt = new Date(Date.UTC(y, m - 1, d));
        if (dt.getUTCMonth() !== m - 1) break;
        if (dt.getUTCDay() === weekday) last = d;
      }
      return last;
    }

    addObserved(year, 1, 1);
    add(year, 1, getNthWeekdayOfMonth(year, 1, 1, 3));
    add(year, 2, getNthWeekdayOfMonth(year, 2, 1, 3));
    add(year, 5, getLastWeekdayOfMonth(year, 5, 1));
    addObserved(year, 6, 19);
    addObserved(year, 7, 4);
    add(year, 9, getNthWeekdayOfMonth(year, 9, 1, 1));
    add(year, 10, getNthWeekdayOfMonth(year, 10, 1, 2));
    addObserved(year, 11, 11);
    add(year, 11, getNthWeekdayOfMonth(year, 11, 4, 4));
    addObserved(year, 12, 25);

    return holidays;
  }

  function isPostalHoliday(year, month, day) {
    var holidays = getPostalHolidays(year);
    var mm = month < 10 ? "0" + month : "" + month;
    var dd = day < 10 ? "0" + day : "" + day;
    return !!holidays[year + "-" + mm + "-" + dd];
  }

  function isDispatchBusinessDay(year, month, day, weekday) {
    if (weekday === 0 || weekday === 6) return false;
    return !isPostalHoliday(year, month, day);
  }

  function getNyDateTime(dateObj) {
    var d = dateObj instanceof Date ? dateObj : new Date(dateObj || Date.now());
    if (typeof Intl !== "undefined" && Intl.DateTimeFormat) {
      try {
        var formatter = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "numeric",
          day: "numeric",
          weekday: "short",
          hour: "numeric",
          minute: "numeric",
          second: "numeric",
          hour12: false
        });
        var parts = formatter.formatToParts(d);
        var p = {};
        for (var i = 0; i < parts.length; i++) {
          p[parts[i].type] = parts[i].value;
        }
        var hour = parseInt(p.hour, 10);
        if (hour === 24) hour = 0;
        var weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        var weekday = weekdayMap[p.weekday] !== undefined ? weekdayMap[p.weekday] : d.getDay();
        return {
          year: parseInt(p.year, 10),
          month: parseInt(p.month, 10),
          day: parseInt(p.day, 10),
          weekday: weekday,
          hour: hour,
          minute: parseInt(p.minute, 10),
          second: parseInt(p.second, 10)
        };
      } catch {
        /* fallback below */
      }
    }
    var utc = d.getTime() + d.getTimezoneOffset() * 60000;
    var etDate = new Date(utc - 3600000 * 4);
    return {
      year: etDate.getFullYear(),
      month: etDate.getMonth() + 1,
      day: etDate.getDate(),
      weekday: etDate.getDay(),
      hour: etDate.getHours(),
      minute: etDate.getMinutes(),
      second: etDate.getSeconds()
    };
  }

  function calculateDispatchStatus(now) {
    var ny = getNyDateTime(now);
    var isTodayBusiness = isDispatchBusinessDay(ny.year, ny.month, ny.day, ny.weekday);
    var cutoffHour = 14;

    if (isTodayBusiness && ny.hour < cutoffHour) {
      var hoursRemaining = cutoffHour - 1 - ny.hour;
      var minutesRemaining = 59 - ny.minute;
      var secondsRemaining = 59 - ny.second;
      var timeStr =
        hoursRemaining > 0
          ? hoursRemaining + "h " + (minutesRemaining < 10 ? "0" : "") + minutesRemaining + "m"
          : minutesRemaining + "m";
      return {
        shipsToday: true,
        cutoffHour: cutoffHour,
        hoursRemaining: hoursRemaining,
        minutesRemaining: minutesRemaining,
        secondsRemaining: secondsRemaining,
        nextDispatchDayLabel: "Today",
        message: "Order in next " + timeStr + " to ship today from Landrum, SC!"
      };
    }

    var curDate = new Date(Date.UTC(ny.year, ny.month - 1, ny.day + 1));
    var daysAhead = 1;
    while (daysAhead < 14) {
      var y = curDate.getUTCFullYear();
      var m = curDate.getUTCMonth() + 1;
      var d = curDate.getUTCDate();
      var wd = curDate.getUTCDay();
      if (isDispatchBusinessDay(y, m, d, wd)) {
        break;
      }
      curDate.setUTCDate(curDate.getUTCDate() + 1);
      daysAhead++;
    }

    var dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    var nextDayLabel = daysAhead === 1 ? "Tomorrow" : dayNames[curDate.getUTCDay()];
    return {
      shipsToday: false,
      cutoffHour: cutoffHour,
      hoursRemaining: 0,
      minutesRemaining: 0,
      secondsRemaining: 0,
      nextDispatchDayLabel: nextDayLabel,
      message: "Ships " + nextDayLabel + " from Landrum, SC · Order by 2 PM ET"
    };
  }

  /* Query live remaining balance of a stored-value gift card from Stripe. */
  function checkGiftCardBalance(code) {
    var clean = String(code || "")
      .trim()
      .toUpperCase();
    if (!clean) return Promise.reject(new Error("Please enter a gift card code."));
    var endpoint = "/.netlify/functions/gift-card-balance?code=" + encodeURIComponent(clean);
    return fetch(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" }
    }).then(function (res) {
      if (!res.ok) {
        return res.json().then(function (data) {
          throw new Error((data && data.error) || "Gift card code not found or exhausted.");
        });
      }
      return res.json();
    });
  }

  /* Redeem loyalty points for a stored-value gift voucher via Netlify function. */
  function redeemPoints(points, email) {
    var pts = Number(points);
    if (!pts || pts < 100) {
      return Promise.reject(new Error("At least 100 Alt-Points are required to redeem."));
    }
    var endpoint = "/.netlify/functions/redeem-points";
    return fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ points: pts, email: email || "" })
    }).then(function (res) {
      if (!res.ok) {
        return res.json().then(function (data) {
          throw new Error((data && data.error) || "Could not redeem Alt-Points.");
        });
      }
      return res.json();
    });
  }

  /* Generate a shareable link that encodes the current cart state. */
  function generateShareCartUrl(items) {
    if (!items || !items.length) return "";
    var compact = items
      .map(function (it) {
        var parts = [it.id, it.qty];
        if (it.variantLabel) parts.push(it.variantLabel);
        return parts.join(":");
      })
      .join(",");
    var origin = typeof window !== "undefined" && window.location ? window.location.origin : "";
    return (origin ? origin : "") + "/shop.html?cart=" + encodeURIComponent(compact);
  }

  /* Parse a compact shared cart query parameter string and validate against catalog. */
  function parseSharedCartParam(cartStr, catalog) {
    if (!cartStr || typeof cartStr !== "string") return [];
    var cat = catalog || getCatalog() || {};
    var products = Array.isArray(cat.products) ? cat.products : [];
    var bundles = Array.isArray(cat.bundles) ? cat.bundles : [];
    var pMap = new Map();
    products.forEach(function (p) {
      if (p && p.id) pMap.set(p.id, p);
    });
    bundles.forEach(function (b) {
      if (b && b.id) {
        pMap.set(b.id, b);
        pMap.set("bundle-" + b.id, b);
      }
    });

    var tokens = cartStr.split(",");
    var items = [];
    tokens.forEach(function (t) {
      var token = t.trim();
      if (!token) return;
      var parts = token.split(":");
      var id = parts[0];
      if (!id) return;
      var rawQty = parseInt(parts[1], 10);
      var variantLabel = parts.slice(2).join(":") || "";
      var product = pMap.get(id);
      if (!product) return;

      var maxQty = product.stock && product.stock > 0 ? product.stock : null;
      var qty = clampQty(isNaN(rawQty) ? 1 : rawQty, maxQty);
      var basePrice = Number(product.price) || 0;
      var variantDelta = 0;
      if (variantLabel && product.variants && Array.isArray(product.variants.options)) {
        var opt = product.variants.options.find(function (o) {
          return (
            (o && o.name === variantLabel) ||
            (o && o.label === variantLabel) ||
            (o && o.id === variantLabel)
          );
        });
        if (opt && typeof opt.priceDelta === "number") {
          variantDelta = opt.priceDelta;
        }
      }

      items.push({
        id: product.id,
        name: product.name,
        price: basePrice,
        image: product.image || "",
        category: product.category || "",
        variantName: variantLabel ? (product.variants && product.variants.name) || "Option" : "",
        variantLabel: variantLabel,
        variantDelta: variantDelta,
        maxQty: maxQty,
        qty: qty
      });
    });
    return items;
  }

  var LOYALTY_STORAGE_KEY = "yl_loyalty_points";

  function getWalletPoints() {
    try {
      var storage =
        typeof localStorage !== "undefined"
          ? localStorage
          : typeof window !== "undefined" && window.localStorage
            ? window.localStorage
            : typeof globalThis !== "undefined" && globalThis.localStorage
              ? globalThis.localStorage
              : null;
      if (!storage) return 0;
      var raw = storage.getItem(LOYALTY_STORAGE_KEY);
      if (raw === null || raw === undefined) return 0;
      var pts = parseInt(raw, 10);
      return isNaN(pts) || pts < 0 ? 0 : pts;
    } catch {
      return 0;
    }
  }

  function setWalletPoints(pts) {
    var n = parseInt(pts, 10);
    var clean = isNaN(n) || n < 0 ? 0 : n;
    try {
      var storage =
        typeof localStorage !== "undefined"
          ? localStorage
          : typeof window !== "undefined" && window.localStorage
            ? window.localStorage
            : typeof globalThis !== "undefined" && globalThis.localStorage
              ? globalThis.localStorage
              : null;
      if (storage) {
        storage.setItem(LOYALTY_STORAGE_KEY, String(clean));
      }
    } catch {
      /* storage unavailable */
    }
    return clean;
  }

  /* Free-shipping threshold in dollars, from products.json
     shop.freeShippingThreshold. Returns 0 when the owner has switched the
     promise off in the CMS ("Set to 0 to disable", admin/config.yml) -- the
     announcement bar in main.js and the Worker's shipping line
     (workers/checkout.js resolveFreeShippingThresholdCents) read that same 0
     the same way, so a disabled promise disappears everywhere instead of only
     from the banner. Only a missing/non-numeric value falls back to the
     default. */
  function freeShipThreshold() {
    var shop = (root.YL_PRODUCTS && root.YL_PRODUCTS.shop) || {};
    var raw = shop.freeShippingThreshold;
    if (raw === null || raw === undefined || raw === "") return DEFAULT_FREE_SHIP;
    var dollars = Number(raw);
    if (!isFinite(dollars)) return DEFAULT_FREE_SHIP;
    return dollars > 0 ? dollars : 0;
  }

  // Expose the pure helpers to Node for testing without touching the DOM layer.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      lineKey: lineKey,
      deltaForLabel: deltaForLabel,
      clampQty: clampQty,
      isQualifying2ozSalve: isQualifying2ozSalve,
      qualifying2ozSalveCount: qualifying2ozSalveCount,
      unitPrice: unitPrice,
      effectiveUnitPrice: unitPrice,
      subtotal: subtotal,
      physicalSubtotal: physicalSubtotal,
      totalCount: totalCount,
      addToList: addToList,
      toCheckoutPayload: toCheckoutPayload,
      checkGiftCardBalance: checkGiftCardBalance,
      redeemPoints: redeemPoints,
      generateShareCartUrl: generateShareCartUrl,
      parseSharedCartParam: parseSharedCartParam,
      getWalletPoints: getWalletPoints,
      setWalletPoints: setWalletPoints,
      freeShipThreshold: freeShipThreshold,
      getVolumePricingRules: getVolumePricingRules,
      itemMatchesRule: itemMatchesRule,
      ruleQualifyingCount: ruleQualifyingCount,
      getActiveRuleForItem: getActiveRuleForItem,
      DEFAULT_VOLUME_PRICING: DEFAULT_VOLUME_PRICING,
      calculateDispatchStatus: calculateDispatchStatus,
      getPostalHolidays: getPostalHolidays,
      isDispatchBusinessDay: isDispatchBusinessDay
    };
  }

  // Everything below needs a browser; bail cleanly under Node (tests).
  if (typeof document === "undefined") return;

  /* ---------------- State + persistence ---------------- */

  var state = {
    items: [],
    appliedGiftCard: null,
    giftCardOpen: false,
    giftCardError: "",
    giftCardLoading: false,
    isGiftOrder: false,
    giftMessage: "",
    pointsRedeeming: false,
    pointsError: "",
    shareCartNotice: ""
  };

  var GC_STORAGE_KEY = "yl_applied_gift_card";

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      state.items = Array.isArray(parsed) ? parsed : [];
    } catch {
      state.items = [];
    }
    try {
      var rawGC = localStorage.getItem(GC_STORAGE_KEY);
      var parsedGC = rawGC ? JSON.parse(rawGC) : null;
      state.appliedGiftCard = parsedGC && parsedGC.code && parsedGC.balance ? parsedGC : null;
    } catch {
      state.appliedGiftCard = null;
    }
    try {
      state.isGiftOrder = localStorage.getItem("yl_is_gift_order") === "true";
      state.giftMessage = localStorage.getItem("yl_gift_message") || "";
    } catch {
      state.isGiftOrder = false;
      state.giftMessage = "";
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.items));
    } catch {
      /* storage full / blocked -- cart still works for this page view */
    }
    try {
      if (state.appliedGiftCard) {
        localStorage.setItem(GC_STORAGE_KEY, JSON.stringify(state.appliedGiftCard));
      } else {
        localStorage.removeItem(GC_STORAGE_KEY);
      }
    } catch {
      /* storage full / blocked */
    }
    try {
      if (state.isGiftOrder) {
        localStorage.setItem("yl_is_gift_order", "true");
      } else {
        localStorage.removeItem("yl_is_gift_order");
      }
      if (state.giftMessage) {
        localStorage.setItem("yl_gift_message", state.giftMessage);
      } else {
        localStorage.removeItem("yl_gift_message");
      }
    } catch {
      /* storage full / blocked */
    }
  }

  function money(n) {
    return "$" + (Math.round(n * 100) / 100).toFixed(2);
  }

  // Unique-enough id for a single gift-card line (see lineKey() above) --
  // must be cryptographically secure to prevent ID guessing or collisions.
  function newLineId() {
    if (root.crypto && typeof root.crypto.randomUUID === "function") {
      try {
        return root.crypto.randomUUID();
      } catch {
        /* fallback below */
      }
    }
    if (root.crypto && typeof root.crypto.getRandomValues === "function") {
      try {
        var array = new Uint32Array(4);
        root.crypto.getRandomValues(array);
        var hex = "";
        for (var i = 0; i < array.length; i++) {
          hex += ("00000000" + array[i].toString(16)).slice(-8);
        }
        return hex;
      } catch {
        /* fallback below */
      }
    }
    // Safe fallback for non-secure contexts / environments lacking Web Crypto
    return "gc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  /* ---------------- Drawer UI ---------------- */

  var drawer, itemsEl, footEl, liveEl, dispatchEl;

  function ensureDrawer() {
    if (drawer) return;
    drawer = document.createElement("div");
    drawer.id = "yl-cart-drawer";
    drawer.className = "yl-cart-drawer";
    drawer.setAttribute("popover", "auto");
    drawer.setAttribute("role", "dialog");
    /* popover="auto" is modal to pointer/Escape but doesn't set modal
       semantics for assistive tech the way <dialog>.showModal() does, so state
       it explicitly -- otherwise a screen reader keeps offering the page
       behind the drawer as if it were still available. */
    drawer.setAttribute("aria-modal", "true");
    drawer.setAttribute("aria-label", "Your cart");
    drawer.innerHTML =
      '<div class="yl-cart-head">' +
      "<h2>Your Cart</h2>" +
      '<button type="button" class="yl-cart-close" aria-label="Close cart">&times;</button>' +
      "</div>" +
      '<div class="yl-cart-dispatch-banner" id="yl-cart-dispatch-banner"></div>' +
      '<div class="yl-cart-items" id="yl-cart-items"></div>' +
      '<div class="yl-cart-foot" id="yl-cart-foot"></div>';
    document.body.appendChild(drawer);
    dispatchEl = drawer.querySelector("#yl-cart-dispatch-banner");
    itemsEl = drawer.querySelector("#yl-cart-items");
    footEl = drawer.querySelector("#yl-cart-foot");

    drawer.querySelector(".yl-cart-close").addEventListener("click", closeDrawer);

    drawer.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        closeDrawer();
        return;
      }
      if (e.key === "Tab") {
        var focusables = drawer.querySelectorAll(
          'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables.length) return;
        var first = focusables[0];
        var last = focusables[focusables.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    });

    // Event delegation for qty +/- and remove.
    itemsEl.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-cart-action]");
      if (!btn) return;
      var key = btn.getAttribute("data-key");
      var action = btn.getAttribute("data-cart-action");
      if (action === "inc") changeQty(key, 1);
      else if (action === "dec") changeQty(key, -1);
      else if (action === "remove") removeLine(key);
    });

    // aria-live region for screen-reader cart announcements.
    liveEl = document.createElement("div");
    liveEl.className = "sr-only";
    liveEl.setAttribute("aria-live", "polite");
    document.body.appendChild(liveEl);
  }

  function openDrawer() {
    ensureDrawer();
    render();
    if (typeof drawer.showPopover === "function") {
      try {
        drawer.showPopover();
      } catch {
        drawer.setAttribute("data-open", "true");
      }
    } else {
      drawer.setAttribute("data-open", "true");
    }
    /* popover="auto" shows the drawer but leaves focus on whatever opened it
       (unlike <dialog>.showModal(), which moves focus in for you). Without
       this, a keyboard user hits Enter on the cart button, the drawer appears,
       and their focus is still out on the header -- the next Tab continues
       through the page behind the drawer instead of into it, and a screen
       reader never announces that anything opened. Move focus to the close
       button, which is both the first control and the escape hatch. */
    var closeBtn = drawer.querySelector(".yl-cart-close");
    if (closeBtn) {
      try {
        closeBtn.focus({ preventScroll: true });
      } catch {
        closeBtn.focus();
      }
    }
  }

  function closeDrawer() {
    if (!drawer) return;
    if (typeof drawer.hidePopover === "function") {
      try {
        drawer.hidePopover();
      } catch {
        drawer.removeAttribute("data-open");
      }
    } else {
      drawer.removeAttribute("data-open");
    }
  }

  function physicalSubtotal(items) {
    var raw = (items || []).reduce(function (sum, it) {
      if (it.id === GIFT_CARD_ID) return sum;
      return sum + unitPrice(it, items) * it.qty;
    }, 0);
    return Math.round(raw * 100) / 100;
  }

  function getLoyaltyConfig() {
    var site = (root.YL_CONTENT && root.YL_CONTENT.site) || {};
    return {
      name: site.loyaltyPointsName || "Alt-Points",
      singular: site.loyaltyPointsSingular || "Alt-Point",
      rate: Number(site.loyaltyPointsPerDollar) > 0 ? Number(site.loyaltyPointsPerDollar) : 1,
      emoji: site.loyaltyBadgeEmoji || "✨",
      enabled: site.enableLoyaltyPoints !== false
    };
  }

  function render() {
    ensureDrawer();
    if (dispatchEl) {
      var dispatchEnabled =
        !root.YL_CONTENT ||
        !root.YL_CONTENT.site ||
        root.YL_CONTENT.site.enableDispatchCountdown !== false;
      if (dispatchEnabled) {
        var status = calculateDispatchStatus();
        dispatchEl.innerHTML =
          '<div class="yl-cart-dispatch-badge" role="status" aria-live="polite">' +
          '<svg class="yl-cart-icon yl-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg> ' +
          "<span>" +
          escapeHtml(status.message) +
          "</span>" +
          "</div>";
        dispatchEl.style.display = "block";
      } else {
        dispatchEl.innerHTML = "";
        dispatchEl.style.display = "none";
      }
    }
    if (!state.items.length) {
      itemsEl.innerHTML = '<p class="yl-cart-empty">Your cart is empty.</p>';
      footEl.innerHTML = "";
      updateBadges();
      return;
    }

    itemsEl.innerHTML = state.items
      .map(function (it) {
        var key = lineKey(it);
        var uPrice = unitPrice(it, state.items);
        var line = uPrice * it.qty;
        var variantText = it.variantLabel ? escapeHtml(it.variantLabel) : "";
        var activeRule = getActiveRuleForItem(it, state.items);
        var isDiscounted = !!activeRule;
        var baseUnitPrice =
          Math.round(Math.max(0, (Number(it.price) || 0) + (Number(it.variantDelta) || 0)) * 100) /
          100;

        var badgeLabel = "";
        if (isDiscounted) {
          var rawLabel =
            activeRule.label ||
            activeRule.minQuantity +
              "+ for $" +
              Number(activeRule.unitPrice).toFixed(2) +
              " applied";
          badgeLabel = rawLabel.replace(/\s*(each|ea)$/i, "") + " applied";
          if (rawLabel.indexOf("applied") !== -1) {
            badgeLabel = rawLabel;
          }
        }

        var recipientText = it.giftRecipientEmail
          ? '<span class="yl-cart-recipient" style="display:block; font-size:0.75rem; color:var(--hide);">For: ' +
            escapeHtml(it.giftRecipientEmail) +
            "</span>"
          : "";

        return (
          '<div class="yl-cart-line yl-cart-item">' +
          '<img class="yl-cart-thumb" src="' +
          escapeAttr(it.image || "") +
          '" alt="" width="60" height="60" loading="lazy">' +
          '<div class="yl-cart-details">' +
          '<div class="yl-cart-title-row">' +
          '<span class="yl-cart-name">' +
          escapeHtml(it.name) +
          "</span>" +
          '<button type="button" class="yl-cart-remove" data-cart-action="remove" data-key="' +
          escapeAttr(key) +
          '" aria-label="Remove item">' +
          '<svg class="yl-cart-icon yl-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>' +
          "</button>" +
          "</div>" +
          (variantText ? '<span class="yl-cart-variant">Variant: ' + variantText + "</span>" : "") +
          (recipientText || "") +
          (isDiscounted
            ? '<span class="yl-cart-badge" style="display:inline-block; font-size:0.72rem; color:var(--whiskey); font-weight:600; margin-top:2px;">' +
              escapeHtml(badgeLabel) +
              "</span>"
            : "") +
          '<div class="yl-cart-actions-row">' +
          '<div class="yl-cart-qty-pill">' +
          '<button type="button" data-cart-action="dec" data-key="' +
          escapeAttr(key) +
          '" aria-label="Decrease quantity">-</button>' +
          '<span class="yl-cart-qty-val">' +
          it.qty +
          "</span>" +
          '<button type="button" data-cart-action="inc" data-key="' +
          escapeAttr(key) +
          '" aria-label="Increase quantity"' +
          (it.maxQty && it.qty >= it.maxQty ? " disabled" : "") +
          ">+</button>" +
          "</div>" +
          '<div class="yl-cart-price-block">' +
          (isDiscounted
            ? '<div style="display:flex; align-items:baseline; gap:4px; justify-content:flex-end;"><s style="color:var(--hide); font-size:0.85em;">' +
              money(baseUnitPrice * it.qty) +
              '</s><span class="yl-cart-line-total">' +
              money(line) +
              "</span></div>"
            : '<span class="yl-cart-line-total">' + money(line) + "</span>") +
          (it.qty > 1 || isDiscounted
            ? '<span class="yl-cart-unit-price">' + money(uPrice) + " ea</span>"
            : "") +
          "</div>" +
          "</div>" +
          "</div>" +
          "</div>"
        );
      })
      .join("");

    var sub = subtotal(state.items);
    var physSub = physicalSubtotal(state.items);
    var threshold = freeShipThreshold();
    var remaining = threshold > 0 ? Math.max(0, threshold - physSub) : 0;

    /* With the promise switched off (threshold 0) there's no progress to
       report and nothing to unlock, so the meter drops out entirely -- but a
       pickup order still gets its "$0 shipping" confirmation, which is about
       pickup, not the free-shipping tier. */
    var shipMsg = state.isPickup
      ? "Local SC Market Pick-up Selected ($0 Shipping)"
      : threshold <= 0
        ? ""
        : remaining > 0
          ? "Add " + money(remaining) + " for free shipping"
          : "You've unlocked free shipping!";
    var pct =
      state.isPickup || threshold <= 0
        ? 100
        : Math.min(100, Math.round((physSub / threshold) * 100));
    var shipHTML = shipMsg
      ? '<div class="yl-cart-ship">' +
        '<div class="yl-cart-ship-msg">' +
        '<svg class="yl-cart-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg> ' +
        escapeHtml(shipMsg) +
        "</div>" +
        '<div class="yl-cart-ship-bar"><span style="width:' +
        pct +
        '%"></span></div>' +
        "</div>"
      : "";

    var siteCfg = (root.YL_CONTENT && root.YL_CONTENT.site) || {};
    var enableGiftOrders = siteCfg.enableGiftOrders !== false;
    var enableShareCart = siteCfg.enableShareCart !== false;

    var loyalty = getLoyaltyConfig();
    var loyaltyHTML = "";
    if (loyalty.enabled) {
      var earnedPoints = Math.floor(physSub * loyalty.rate);
      var walletBalance = getWalletPoints();
      var pointsMsg =
        earnedPoints > 0
          ? 'You\'ll earn <strong id="cart-points-count">' +
            earnedPoints +
            "</strong> " +
            (earnedPoints === 1 ? escapeHtml(loyalty.singular) : escapeHtml(loyalty.name)) +
            " with this order!"
          : "Add physical items to earn " +
            escapeHtml(loyalty.name) +
            " ($1 = " +
            loyalty.rate +
            " point" +
            (loyalty.rate === 1 ? "" : "s") +
            ")!";

      var redeemBtnHTML = "";
      if (state.pointsRedeeming) {
        redeemBtnHTML =
          '<div class="yl-cart-wallet-redeem-row"><span class="yl-cart-wallet-loading">Redeeming reward voucher…</span></div>';
      } else if (walletBalance >= 100) {
        redeemBtnHTML =
          '<div class="yl-cart-wallet-redeem-row">' +
          '  <button type="button" class="yl-cart-redeem-btn" data-redeem-points="100">' +
          '    <svg class="yl-cart-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> Redeem 100 ' +
          escapeHtml(loyalty.name) +
          " ($5.00 Off)" +
          "  </button>" +
          (walletBalance >= 200
            ? '  <button type="button" class="yl-cart-redeem-btn" data-redeem-points="200">Redeem 200 ' +
              escapeHtml(loyalty.name) +
              " ($10.00 Off)</button>"
            : "") +
          "</div>";
      } else {
        var ptsToNext = 100 - walletBalance;
        redeemBtnHTML =
          '<div class="yl-cart-wallet-needed">' +
          ptsToNext +
          " more points to unlock a $5 reward voucher</div>";
      }

      var pointsErrorHTML = state.pointsError
        ? '<div class="yl-cart-points-error">' + escapeHtml(state.pointsError) + "</div>"
        : "";

      loyaltyHTML =
        '<div class="yl-cart-loyalty-card">' +
        '  <div class="yl-cart-points">' +
        '    <span class="yl-cart-points-icon" aria-hidden="true"><svg class="yl-cart-icon yl-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></span> ' +
        '    <span id="cart-points-banner">' +
        pointsMsg +
        "    </span>" +
        "  </div>" +
        '  <div class="yl-cart-wallet-block">' +
        '    <div class="yl-cart-wallet-header">' +
        '      <span class="yl-cart-wallet-title">Alt-Points Wallet:</span>' +
        '      <span class="yl-cart-wallet-balance" id="yl-loyalty-wallet-balance"><strong>' +
        walletBalance +
        "</strong> " +
        escapeHtml(loyalty.name) +
        "</span>" +
        "    </div>" +
        redeemBtnHTML +
        pointsErrorHTML +
        "  </div>" +
        "</div>";
    }

    var pickupHTML = "";
    if (
      !root.YL_CONTENT ||
      !root.YL_CONTENT.site ||
      root.YL_CONTENT.site.enableLocalPickup !== false
    ) {
      var upcomingEvts =
        root.YL_EVENTS && Array.isArray(root.YL_EVENTS.upcoming) ? root.YL_EVENTS.upcoming : [];
      var optionsHTML = upcomingEvts
        .map(function (evt) {
          var label =
            (evt.name || "Pop-up Market") +
            " — " +
            (evt.dateLabel || "") +
            " (" +
            (evt.location || "Landrum, SC") +
            ")";
          return (
            '<option value="' +
            escapeAttr(label) +
            '"' +
            (state.pickupMarket === label ? " selected" : "") +
            ">" +
            escapeHtml(label) +
            "</option>"
          );
        })
        .join("");

      if (!optionsHTML) {
        optionsHTML =
          '<option value="Landrum SC Farmers Market (Saturdays 9am-12pm)">Landrum SC Farmers Market (Saturdays 9am-12pm)</option>';
      }

      if (!state.pickupMarket && upcomingEvts[0]) {
        var defaultEvt = upcomingEvts[0];
        state.pickupMarket =
          (defaultEvt.name || "Pop-up Market") +
          " — " +
          (defaultEvt.dateLabel || "") +
          " (" +
          (defaultEvt.location || "Landrum, SC") +
          ")";
      }

      pickupHTML =
        '<div class="yl-cart-pickup-wrap' +
        (state.isPickup ? " is-active" : "") +
        '">' +
        '  <label class="yl-cart-pickup-label" for="yl-cart-pickup-checkbox">' +
        '    <input type="checkbox" id="yl-cart-pickup-checkbox"' +
        (state.isPickup ? " checked" : "") +
        "    >" +
        '    <span class="yl-cart-pickup-custom-check" aria-hidden="true"></span>' +
        '    <div class="yl-cart-pickup-text">' +
        '      <span class="yl-cart-pickup-title">Local SC Market Pick-up (Free)</span>' +
        '      <span class="yl-cart-pickup-sub">Skip shipping &amp; collect at our next market booth</span>' +
        "    </div>" +
        "  </label>" +
        '  <div id="yl-cart-pickup-select-container" class="yl-cart-pickup-select-container"' +
        (state.isPickup ? ' style="display: block;"' : ' style="display: none;"') +
        "  >" +
        '    <label for="yl-cart-pickup-select" class="yl-cart-pickup-select-label">Choose Upcoming Market Location:</label>' +
        '    <div class="yl-cart-select-wrap">' +
        '      <select id="yl-cart-pickup-select" class="yl-cart-pickup-select">' +
        optionsHTML +
        "      </select>" +
        "    </div>" +
        "  </div>" +
        "</div>";
    }

    var volumeNudgesHTML = "";
    var allRules = getVolumePricingRules();
    var nudgeMessages = [];
    for (var rIdx = 0; rIdx < allRules.length; rIdx++) {
      var rule = allRules[rIdx];
      var count = ruleQualifyingCount(rule, state.items);
      var minQ = typeof rule.minQuantity === "number" ? rule.minQuantity : 2;
      var catNoun =
        rule.category === "salves" ? "salve" : rule.category === "soaks" ? "soak" : rule.category;
      var variantPart = rule.qualifyingVariant ? rule.qualifyingVariant + " " : "";
      var priceFormatted = "$" + Number(rule.unitPrice).toFixed(2);

      if (count > 0 && count < minQ) {
        var needed = minQ - count;
        var pluralUnit = minQ === 2 ? "both" : "all " + minQ;
        nudgeMessages.push(
          '<div class="yl-cart-salve-nudge"><svg class="yl-cart-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"></path><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"></path></svg> <strong>Mix &amp; Match:</strong> Add ' +
            needed +
            " more " +
            variantPart +
            catNoun +
            " to get " +
            pluralUnit +
            " for " +
            priceFormatted +
            " each!</div>"
        );
      } else if (count >= minQ) {
        var shipExtra =
          remaining > 0 && !state.isPickup && threshold > 0
            ? " · Add " + money(remaining) + " for FREE SHIPPING!"
            : "";
        nudgeMessages.push(
          '<div class="yl-cart-salve-nudge yl-cart-salve-nudge-active"><svg class="yl-cart-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> <strong>Mix &amp; Match:</strong> ' +
            priceFormatted +
            "/ea " +
            variantPart +
            catNoun +
            " volume tier applied!" +
            shipExtra +
            "</div>"
        );
      }
    }
    volumeNudgesHTML = nudgeMessages.join("");

    var giftOrderHTML = "";
    if (enableGiftOrders) {
      giftOrderHTML =
        '<div class="yl-cart-giftorder-wrap">' +
        '  <label class="yl-cart-giftorder-label" for="yl-cart-giftorder-checkbox">' +
        '    <input type="checkbox" id="yl-cart-giftorder-checkbox"' +
        (state.isGiftOrder ? " checked" : "") +
        "    >" +
        '    <span class="yl-cart-giftorder-custom-check" aria-hidden="true"></span>' +
        '    <span class="yl-cart-giftorder-title"><svg class="yl-cart-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 12 20 22 4 22 4 12"></polyline><rect x="2" y="7" width="20" height="5"></rect><line x1="12" y1="22" x2="12" y2="7"></line><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"></path><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"></path></svg> This order is a gift</span>' +
        "  </label>" +
        '  <div class="yl-cart-giftmessage-container"' +
        (state.isGiftOrder ? ' style="display: block;"' : ' style="display: none;"') +
        "  >" +
        '    <textarea id="yl-cart-giftmessage-input" class="yl-cart-giftmessage-input" placeholder="Add a free gift note for the packing slip (Max 500 characters)..." maxlength="500" rows="2" aria-label="Gift note message">' +
        escapeHtml(state.giftMessage || "") +
        "</textarea>" +
        "  </div>" +
        "</div>";
    }

    var gcDiscount = 0;
    var finalDue = sub;
    if (state.appliedGiftCard && state.appliedGiftCard.balance) {
      gcDiscount = Math.min(sub, state.appliedGiftCard.balance);
      finalDue = Math.max(0, sub - gcDiscount);
    }

    var giftCardHTML =
      '<div class="yl-cart-giftcard-wrap">' +
      (state.appliedGiftCard
        ? '<div class="yl-cart-giftcard-applied">' +
          '  <div class="yl-cart-giftcard-applied-info">' +
          '    <span class="yl-cart-giftcard-applied-code"><svg class="yl-cart-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 12 20 22 4 22 4 12"></polyline><rect x="2" y="7" width="20" height="5"></rect><line x1="12" y1="22" x2="12" y2="7"></line><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"></path><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"></path></svg> ' +
          escapeHtml(state.appliedGiftCard.code) +
          "</span>" +
          '    <span class="yl-cart-giftcard-applied-bal">$' +
          Number(state.appliedGiftCard.balance).toFixed(2) +
          " available</span>" +
          "  </div>" +
          '  <button type="button" class="yl-cart-giftcard-remove" aria-label="Remove gift card">Remove</button>' +
          "</div>"
        : '<button type="button" class="yl-cart-giftcard-toggle" aria-expanded="' +
          (state.giftCardOpen ? "true" : "false") +
          '">' +
          '  <svg class="yl-cart-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 12 20 22 4 22 4 12"></polyline><rect x="2" y="7" width="20" height="5"></rect><line x1="12" y1="22" x2="12" y2="7"></line><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"></path><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"></path></svg> Have a gift card or voucher code?' +
          "</button>" +
          '<div class="yl-cart-giftcard-form"' +
          (state.giftCardOpen ? ' style="display: flex;"' : ' style="display: none;"') +
          ">" +
          '  <div class="yl-cart-giftcard-input-row">' +
          '    <input type="text" class="yl-cart-giftcard-input" placeholder="YALL-XXXXXXXX" maxlength="20" aria-label="Gift card code">' +
          '    <button type="button" class="yl-cart-giftcard-btn"' +
          (state.giftCardLoading ? " disabled" : "") +
          ">" +
          (state.giftCardLoading ? "Checking…" : "Apply") +
          "</button>" +
          "  </div>" +
          (state.giftCardError
            ? '  <div class="yl-cart-giftcard-msg">' + escapeHtml(state.giftCardError) + "</div>"
            : "") +
          "</div>") +
      "</div>";

    var totalsHTML =
      '<div class="yl-cart-subtotal"><span>Subtotal</span><strong>' +
      money(sub) +
      "</strong></div>" +
      (gcDiscount > 0
        ? '<div class="yl-cart-discount-line"><span>Gift Card Discount (' +
          escapeHtml(state.appliedGiftCard.code) +
          ")</span><strong>-" +
          money(gcDiscount) +
          "</strong></div>" +
          '<div class="yl-cart-subtotal yl-cart-total-due" style="border-top: 1px solid rgba(255,255,255,0.1); margin-top: 6px; padding-top: 6px;"><span>Total Due</span><strong>' +
          money(finalDue) +
          "</strong></div>"
        : "");

    var shareCartHTML = "";
    if (enableShareCart) {
      shareCartHTML =
        '<div class="yl-cart-share-wrap">' +
        '  <button type="button" class="yl-cart-share-btn" aria-label="Share cart link">' +
        '    <svg class="yl-cart-icon yl-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path><polyline points="16 6 12 2 8 6"></polyline><line x1="12" y1="2" x2="12" y2="15"></line></svg> ' +
        (state.shareCartNotice || "Share Cart with Friend") +
        "  </button>" +
        "</div>";
    }

    footEl.innerHTML =
      upsellHTML() +
      volumeNudgesHTML +
      loyaltyHTML +
      giftOrderHTML +
      pickupHTML +
      shipHTML +
      giftCardHTML +
      totalsHTML +
      '<button type="button" class="btn btn-primary btn-block yl-cart-checkout">Checkout</button>' +
      shareCartHTML +
      '<p class="yl-cart-note">Promo codes, gift cards &amp; taxes applied at checkout.</p>';

    footEl.querySelector(".yl-cart-checkout").addEventListener("click", checkout);

    var gcToggleBtn = footEl.querySelector(".yl-cart-giftcard-toggle");
    if (gcToggleBtn) {
      gcToggleBtn.addEventListener("click", function () {
        state.giftCardOpen = !state.giftCardOpen;
        state.giftCardError = "";
        render();
        if (state.giftCardOpen) {
          var inp = footEl.querySelector(".yl-cart-giftcard-input");
          if (inp) inp.focus();
        }
      });
    }

    var gcApplyBtn = footEl.querySelector(".yl-cart-giftcard-btn");
    var gcInput = footEl.querySelector(".yl-cart-giftcard-input");
    function doApplyGC() {
      if (!gcInput) return;
      var code = gcInput.value.trim().toUpperCase();
      if (!code) {
        state.giftCardError = "Please enter a gift card code.";
        render();
        return;
      }
      state.giftCardLoading = true;
      state.giftCardError = "";
      render();
      checkGiftCardBalance(code)
        .then(function (data) {
          state.giftCardLoading = false;
          if (data && data.valid && data.balance > 0) {
            state.appliedGiftCard = data;
            state.giftCardOpen = false;
            save();
            render();
            announce("Gift card " + data.code + " applied (" + money(data.balance) + " available)");
          } else {
            state.giftCardError = (data && data.error) || "Gift card code not found or exhausted.";
            render();
          }
        })
        .catch(function (err) {
          state.giftCardLoading = false;
          state.giftCardError = err.message || "Could not check gift card balance.";
          render();
        });
    }

    if (gcApplyBtn) {
      gcApplyBtn.addEventListener("click", doApplyGC);
    }
    if (gcInput) {
      gcInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          doApplyGC();
        }
      });
    }

    var gcRemoveBtn = footEl.querySelector(".yl-cart-giftcard-remove");
    if (gcRemoveBtn) {
      gcRemoveBtn.addEventListener("click", function () {
        state.appliedGiftCard = null;
        save();
        render();
        announce("Gift card removed");
      });
    }

    var redeemBtns = footEl.querySelectorAll(".yl-cart-redeem-btn");
    redeemBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var pts = parseInt(btn.getAttribute("data-redeem-points") || "100", 10);
        redeemLoyaltyPoints(pts).catch(function () {});
      });
    });

    var giftOrderCb = footEl.querySelector("#yl-cart-giftorder-checkbox");
    var giftMsgInput = footEl.querySelector("#yl-cart-giftmessage-input");
    if (giftOrderCb) {
      giftOrderCb.addEventListener("change", function () {
        state.isGiftOrder = giftOrderCb.checked;
        save();
        render();
      });
    }
    if (giftMsgInput) {
      giftMsgInput.addEventListener("input", function () {
        state.giftMessage = giftMsgInput.value.slice(0, 500);
        save();
      });
    }

    var shareBtn = footEl.querySelector(".yl-cart-share-btn");
    if (shareBtn) {
      shareBtn.addEventListener("click", function () {
        var url = generateShareCartUrl(state.items);
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(url).then(function () {
            state.shareCartNotice = "Link Copied to Clipboard!";
            render();
            announce("Cart share link copied to clipboard");
            setTimeout(function () {
              state.shareCartNotice = "";
              render();
            }, 3000);
          });
        } else {
          prompt("Copy your cart share link:", url);
        }
      });
    }

    var pickupCb = footEl.querySelector("#yl-cart-pickup-checkbox");
    var pickupSelect = footEl.querySelector("#yl-cart-pickup-select");
    var pickupContainer = footEl.querySelector("#yl-cart-pickup-select-container");

    if (pickupCb) {
      pickupCb.addEventListener("change", function () {
        state.isPickup = pickupCb.checked;
        if (pickupContainer) {
          pickupContainer.style.display = state.isPickup ? "block" : "none";
        }
        if (pickupSelect) {
          state.pickupMarket = pickupSelect.value;
        }
        render();
      });
    }

    if (pickupSelect) {
      pickupSelect.addEventListener("change", function () {
        state.pickupMarket = pickupSelect.value;
      });
    }

    var upsellRow = footEl.querySelector(".yl-cart-upsell");
    if (upsellRow) {
      upsellRow.addEventListener("click", function (e) {
        var b = e.target.closest("[data-upsell-add]");
        if (!b) return;
        addUpsell(b.getAttribute("data-upsell-add"));
      });
    }
    updateBadges();
  }

  /* ---------------- Upsell suggestions ----------------
     Best-practice cart-drawer lever: 2-3 relevant, one-click, variant-free
     suggestions typically add 5-10% to AOV. We only ever suggest real,
     in-stock products (from window.YL_PRODUCTS) that have no variant to
     pick (so "add" is truly one click) and aren't already in the cart. */
  function upsellCandidates() {
    var catalog =
      root.YL_PRODUCTS && Array.isArray(root.YL_PRODUCTS.products) ? root.YL_PRODUCTS.products : [];
    var inCart = {};
    state.items.forEach(function (it) {
      inCart[it.id] = true;
    });
    return catalog
      .filter(function (p) {
        var hasVariant = p.variants && p.variants.options && p.variants.options.length;
        var soldOut = p.stock === 0 || p.comingSoon;
        return !hasVariant && !soldOut && !inCart[p.id] && p.id !== "yallternative-gift-card";
      })
      .slice(0, 3);
  }

  function upsellHTML() {
    var picks = upsellCandidates();
    if (!picks.length) return "";
    var cards = picks
      .map(function (p) {
        return (
          '<button type="button" class="yl-cart-upsell-item" data-upsell-add="' +
          escapeAttr(p.id) +
          '">' +
          '<img src="' +
          escapeAttr(p.image || "") +
          '" alt="" width="40" height="40" loading="lazy">' +
          '<div class="yl-cart-upsell-info">' +
          '<span class="yl-cart-upsell-name">' +
          escapeHtml(p.name) +
          "</span>" +
          '<span class="yl-cart-upsell-add">+ Add ' +
          money(Number(p.price) || 0) +
          "</span>" +
          "</div>" +
          "</button>"
        );
      })
      .join("");
    return (
      '<div class="yl-cart-upsell">' +
      '<p class="yl-cart-upsell-title"><svg class="yl-cart-icon yl-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> You Might Also Like</p>' +
      '<div class="yl-cart-upsell-list">' +
      cards +
      "</div>" +
      "</div>"
    );
  }

  var cartProductMapCache = null;

  function getCartProductMap() {
    var products = (root.YL_PRODUCTS && root.YL_PRODUCTS.products) || [];
    var bundles = (root.YL_PRODUCTS && root.YL_PRODUCTS.bundles) || [];
    var expectedCount = products.length + bundles.length * 2;
    if (!cartProductMapCache || cartProductMapCache.size !== expectedCount) {
      cartProductMapCache = new Map();
      products.forEach(function (p) {
        if (p && p.id) {
          cartProductMapCache.set(p.id, p);
        }
      });
      bundles.forEach(function (b) {
        if (b && b.id) {
          cartProductMapCache.set(b.id, b);
          cartProductMapCache.set("bundle-" + b.id, b);
        }
      });
    }
    return cartProductMapCache;
  }

  function addUpsell(id) {
    var pMap = getCartProductMap();
    var p = pMap.get(id);
    if (!p) {
      var catalog =
        root.YL_PRODUCTS && Array.isArray(root.YL_PRODUCTS.products)
          ? root.YL_PRODUCTS.products
          : [];
      p = catalog.find(function (x) {
        return x.id === id;
      });
    }
    if (!p) return;
    state.items = addToList(state.items, {
      id: p.id,
      name: p.name,
      price: Number(p.price) || 0,
      image: p.image || "",
      variantName: "",
      variantLabel: "",
      variantDelta: 0,
      qty: 1
    });
    save();
    render();
    announce(p.name + " added to cart");
  }

  /* ---------------- Cart operations ---------------- */

  function addItemFromButton(btn) {
    var d = btn.dataset;
    var variantLabel = d.itemCustom1Value || "";
    var variantName = d.itemCustom1Name || "";
    var variantDelta = deltaForLabel(d.itemCustom1Options, variantLabel);
    var parsedMax = parseInt(d.itemMaxQuantity, 10);
    var item = {
      id: d.itemId,
      name: d.itemName,
      price: parseFloat(d.itemPrice) || 0,
      image: d.itemImage || "",
      category: d.itemCategories || "",
      variantName: variantName,
      variantLabel: variantLabel,
      variantDelta: variantDelta,
      maxQty: !isNaN(parsedMax) && parsedMax > 0 ? parsedMax : null,
      qty: 1
    };
    if (d.itemId === GIFT_CARD_ID) {
      // Every gift-card add is its own line (see lineKey()); capture the
      // recipient/sender/message fields gift-card.js keeps in sync on the
      // button so they travel through to Stripe as metadata at checkout.
      item.lineId = newLineId();
      item.giftRecipientEmail = d.itemCustom2Value || "";
      item.giftSenderName = d.itemCustom3Value || "";
      item.giftMessage = d.itemCustom4Value || "";
      item.maxQty = 1; // 1 card per line item ensures recipient isolation
    }
    state.items = addToList(state.items, item);
    save();
    render();
    openDrawer();
    announce(item.name + " added to cart");
  }

  function changeQty(key, delta) {
    for (var i = 0; i < state.items.length; i++) {
      if (lineKey(state.items[i]) === key) {
        var next = state.items[i].qty + delta;
        if (next < 1) {
          state.items.splice(i, 1);
        } else {
          state.items[i].qty = clampQty(next, state.items[i].maxQty);
        }
        break;
      }
    }
    save();
    render();
  }

  function removeLine(key) {
    state.items = state.items.filter(function (it) {
      return lineKey(it) !== key;
    });
    save();
    render();
  }

  function checkout() {
    if (!state.items.length) return;
    var btn = footEl.querySelector(".yl-cart-checkout");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Redirecting…";
    }
    fetch(CHECKOUT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        toCheckoutPayload(
          state.items,
          state.isPickup ? state.pickupMarket : null,
          state.appliedGiftCard ? state.appliedGiftCard.code : null,
          state.isGiftOrder,
          state.giftMessage
        )
      )
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (data && data.url) {
          window.location = data.url;
        } else {
          throw new Error((data && data.error) || "Checkout unavailable");
        }
      })
      .catch(function (err) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Checkout";
        }
        announce("Checkout error: " + err.message);
        showCheckoutError(
          "Sorry -- checkout isn't available right now. Please try again in a moment."
        );
      });
  }

  function clear() {
    state.items = [];
    state.isGiftOrder = false;
    state.giftMessage = "";
    save();
    render();
  }

  /* ---------------- Badges + helpers ---------------- */

  function updateBadges() {
    var count = totalCount(state.items);
    var badges = document.querySelectorAll(".cart-toggle .badge, [data-cart-count]");
    badges.forEach(function (b) {
      b.textContent = count > 0 ? String(count) : "";
    });
  }

  function announce(msg) {
    if (liveEl) liveEl.textContent = msg;
  }

  function showCheckoutError(msg) {
    if (!footEl) return;
    var existing = footEl.querySelector(".yl-cart-error");
    if (!existing) {
      existing = document.createElement("p");
      existing.className = "yl-cart-error";
      existing.setAttribute("role", "alert");
      var note = footEl.querySelector(".yl-cart-note");
      if (note) footEl.insertBefore(existing, note);
      else footEl.appendChild(existing);
    }
    existing.textContent = msg;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/`/g, "&#96;");
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  /* ---------------- Public add methods ---------------- */

  function addItem(item) {
    if (!item || !item.id) return;
    ensureDrawer();
    state.items = addToList(state.items, {
      id: item.id,
      name: item.name || item.id,
      price: Number(item.price) || 0,
      image: item.image || "",
      category: item.category || "",
      variantName: item.variantName || "",
      variantLabel: item.variantLabel || item.variant || "",
      variantDelta: Number(item.variantDelta) || 0,
      maxQty: item.maxQty || null,
      qty: Number(item.qty) > 0 ? Number(item.qty) : 1
    });
    save();
    render();
    openDrawer();
    announce((item.name || "Item") + " added to cart");
  }

  function addItems(itemsArray) {
    if (!Array.isArray(itemsArray) || !itemsArray.length) return;
    ensureDrawer();
    itemsArray.forEach(function (item) {
      if (!item || !item.id) return;
      state.items = addToList(state.items, {
        id: item.id,
        name: item.name || item.id,
        price: Number(item.price) || 0,
        image: item.image || "",
        category: item.category || "",
        variantName: item.variantName || "",
        variantLabel: item.variantLabel || item.variant || "",
        variantDelta: Number(item.variantDelta) || 0,
        maxQty: item.maxQty || null,
        qty: Number(item.qty) > 0 ? Number(item.qty) : 1
      });
    });
    save();
    render();
    openDrawer();
    announce(itemsArray.length + " items added to cart");
  }

  function redeemLoyaltyPoints(points) {
    var pts = parseInt(points, 10) || 100;
    var currentBal = getWalletPoints();
    if (currentBal < pts) {
      state.pointsError = "You need at least " + pts + " Alt-Points in your wallet to redeem.";
      render();
      return Promise.reject(new Error("Insufficient Alt-Points"));
    }
    state.pointsRedeeming = true;
    state.pointsError = "";
    render();

    return redeemPoints(pts)
      .then(function (data) {
        state.pointsRedeeming = false;
        if (data && data.code) {
          var newBal = setWalletPoints(currentBal - pts);
          var discountAmount = Number(data.balance) || (pts === 100 ? 5.0 : (pts / 100) * 5.0);
          state.appliedGiftCard = {
            code: data.code,
            balance: discountAmount,
            valid: true
          };
          save();
          render();
          announce(
            "Redeemed " +
              pts +
              " points! Reward " +
              data.code +
              " applied (-$" +
              discountAmount.toFixed(2) +
              "). New balance: " +
              newBal +
              " points."
          );
          return data;
        } else {
          throw new Error((data && data.error) || "Could not redeem Alt-Points.");
        }
      })
      .catch(function (err) {
        state.pointsRedeeming = false;
        state.pointsError = err.message || "Could not redeem Alt-Points.";
        render();
        throw err;
      });
  }

  function restoreCartFromUrl(searchStr) {
    var search =
      searchStr !== undefined
        ? searchStr
        : typeof window !== "undefined" && window.location
          ? window.location.search
          : "";
    if (!search) return false;
    var siteCfg = (root.YL_CONTENT && root.YL_CONTENT.site) || {};
    if (siteCfg.enableShareCart === false) return false;

    var params = new URLSearchParams(search);
    var cartParam = params.get("cart");
    if (!cartParam) return false;

    var catalog = getCatalog();
    var parsedItems = parseSharedCartParam(cartParam, catalog);
    if (!parsedItems.length) return false;

    parsedItems.forEach(function (item) {
      state.items = addToList(state.items, item);
    });
    save();
    render();
    updateBadges();

    if (typeof window !== "undefined" && window.history && window.history.replaceState) {
      try {
        params.delete("cart");
        var newSearch = params.toString();
        var newUrl =
          window.location.pathname + (newSearch ? "?" + newSearch : "") + window.location.hash;
        window.history.replaceState(null, "", newUrl);
      } catch {
        /* ignore */
      }
    }
    openDrawer();
    announce(
      "Shared cart loaded with " +
        parsedItems.length +
        " item" +
        (parsedItems.length === 1 ? "" : "s") +
        "!"
    );
    return true;
  }

  /* ---------------- Init / wiring ---------------- */

  var initialized = false;
  function init(opts) {
    opts = opts || {};
    if (initialized && !opts.force) return;
    initialized = true;
    load();
    ensureDrawer();
    updateBadges();

    var siteCfg = (root.YL_CONTENT && root.YL_CONTENT.site) || {};
    if (siteCfg.enableShareCart !== false) {
      restoreCartFromUrl();
    }

    if (typeof window !== "undefined" && window.location && window.location.search) {
      var params = new URLSearchParams(window.location.search);
      var market = params.get("pickup_market") || params.get("pickup");
      if (market && siteCfg.enableLocalPickup !== false) {
        state.isPickup = true;
        state.pickupMarket = decodeURIComponent(market);
        save();
        render();
      }
    }

    // Add to Cart (buttons keep their existing classes/attributes --
    // .yl-add-item is a holdover name for "the add-to-cart button class,"
    // not a reference to any particular cart backend).
    document.addEventListener("click", function (e) {
      var addBtn = e.target.closest(".yl-add-item, [data-yl-add]");
      if (addBtn) {
        e.preventDefault();
        addItemFromButton(addBtn);
        return;
      }
      // Cart icon in the nav opens our drawer.
      var toggle = e.target.closest(".cart-toggle, [data-yl-cart-open]");
      if (toggle) {
        e.preventDefault();
        openDrawer();
      }
    });

    // Cross-tab sync: when the cart changes in another tab, this tab's
    // localStorage fires a `storage` event -- reload state and re-render so
    // the badge/drawer never show stale counts across tabs.
    window.addEventListener("storage", function (e) {
      if (e.key === STORAGE_KEY) {
        load();
        render();
        updateBadges();
      }
    });
  }

  /* Add a build-your-own box built by main.js's initCustomBox(). The price
     passed in is for display in the drawer only -- workers/checkout.js
     recomputes it from boxProductIds before charging anything, so a tampered
     value here can't change what the customer actually pays. */
  function addCustomBox(box) {
    if (!box || !Array.isArray(box.productIds) || !box.productIds.length) return;
    ensureDrawer();
    state.items = addToList(state.items, {
      id: "custom-box",
      name: "Build-Your-Own Box (" + box.productIds.length + " items)",
      price: box.price,
      image: null,
      variantLabel: "",
      variantDelta: 0,
      boxProductIds: box.productIds.slice(),
      qty: 1
    });
    save();
    render();
    openDrawer();
    announce("Custom box added to cart.");
  }

  root.YLCart = {
    init: init,
    open: openDrawer,
    close: closeDrawer,
    clear: clear,
    addItem: addItem,
    addItems: addItems,
    addCustomBox: addCustomBox,
    getWalletPoints: getWalletPoints,
    setWalletPoints: setWalletPoints,
    redeemLoyaltyPoints: redeemLoyaltyPoints,
    restoreCartFromUrl: restoreCartFromUrl,
    parseSharedCartParam: parseSharedCartParam,
    count: function () {
      return totalCount(state.items);
    },
    items: function () {
      return state.items.slice();
    }
  };

  // Self-initialize: including this script on a page is the only setup
  // required. Runs after DOM parsing (this script is loaded with `defer`,
  // so DOMContentLoaded may already have fired by the time we get here).
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      init();
    });
  } else {
    init();
  }
})(typeof window !== "undefined" ? window : this);
