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
  /* Same Worker, same-origin through the Netlify proxy. The legacy Netlify
     function path this replaced answers 410 now, so nothing on the site may
     name it any more. */
  var GIFT_CARD_BALANCE_URL = "/api/gift-card-balance";
  var GIFT_CARD_THROTTLED = "Too many attempts, try again in a minute.";
  /* The Worker's own words when a concurrent spend beat this session to the
     card. Only a fallback: it sends this text with the 409. */
  var GIFT_CARD_CONFLICT = "That gift card balance changed; please re-apply it.";
  var DEFAULT_FREE_SHIP = 40; // products.json shop.freeShippingThreshold
  var MAX_QTY = 99;
  var GIFT_CARD_ID = "yallternative-gift-card";
  /* Flat shipping rate below the free-shipping threshold. Mirrors
     flatShippingRateCents in workers/checkout.js -- a business constant, not
     a CMS field -- so the drawer quotes the same number Stripe charges. */
  var FLAT_SHIPPING = 10;
  /* Bumping this means the stored cart shape changed; load() migrates
     anything older (see parseStoredCart). */
  var STORAGE_VERSION = 1;

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

  /* Gift cards are issued as YALL-XXXX-XXXX-XXXX: twelve characters over an
     A-Z2-9 alphabet with the ambiguous letters removed. Shoppers type them in
     lowercase, paste them with the dashes stripped by their mail client, or
     copy them out of a PDF with a stray space in the middle -- every one of
     those is the same card, and sending them through unnormalised turns a
     valid card into a 404 the shopper cannot explain.

     Fold to one canonical form before the lookup, and display that form so
     the code on screen matches the code on the card. A code of any other
     length keeps its single dash rather than being regrouped into fours: the
     legacy 8-character cards (YALL-XXXXXXXX) are still live and still spend,
     so inventing dash positions for them would break a real code. */
  function normalizeGiftCardCode(code) {
    var raw = String(code == null ? "" : code)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!raw) return "";
    if (raw.indexOf("YALL") !== 0) return raw;
    var body = raw.slice(4);
    if (!body) return raw;
    if (body.length === 12) {
      return "YALL-" + body.slice(0, 4) + "-" + body.slice(4, 8) + "-" + body.slice(8);
    }
    return "YALL-" + body;
  }

  /* Query live remaining balance of a stored-value gift card.

     POSTed, not GETed: a code in the query string ends up in browser history,
     the Referer header, any CDN/proxy access log and the service worker's
     cache key. The Worker takes {code} as a JSON body and answers
     Cache-Control: no-store; sw.js additionally refuses to touch /api/ at all
     (see its fetch handler). */
  function checkGiftCardBalance(code) {
    var clean = normalizeGiftCardCode(code);
    if (!clean) return Promise.reject(new Error("Please enter a gift card code."));
    return fetch(GIFT_CARD_BALANCE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code: clean })
    }).then(function (res) {
      if (!res.ok) {
        return readJsonSafely(res).then(function (data) {
          /* 429 is the endpoint's rate limiter, not a verdict on the code.
             Repeating "not found" here would send the shopper hunting for a
             second card they do not have, and hammering a throttle that only
             clears with silence. */
          if (res.status === 429) throw new Error(GIFT_CARD_THROTTLED);
          throw new Error((data && data.error) || "Gift card code not found or exhausted.");
        });
      }
      return readJsonSafely(res).then(function (data) {
        if (!data || typeof data !== "object") {
          throw new Error("Gift card code not found or exhausted.");
        }
        /* Display the canonical form even if the endpoint echoes a bare one. */
        data.code = normalizeGiftCardCode(data.code) || clean;
        return data;
      });
    });
  }

  /* A failing endpoint answers with an HTML error page or an empty body at
     least as often as it answers with JSON, and res.json() rejects on both.
     Never let that rejection replace the real failure with a parser error. */
  function readJsonSafely(res) {
    if (!res || typeof res.json !== "function") return Promise.resolve(null);
    var parsed;
    try {
      parsed = res.json();
    } catch {
      return Promise.resolve(null);
    }
    return Promise.resolve(parsed).then(
      function (data) {
        return data;
      },
      function () {
        return null;
      }
    );
  }

  /* Alt-Points redemption is switched off end to end. The old redeem-points
     endpoint is gone (it answers 410 and mints nothing), so there is no
     voucher to hand back and nothing left to call: the whole helper went with
     it. All that survives is the redeemLoyaltyPoints stub on the public
     surface, so a cached page or an old inline handler gets a clean rejection
     instead of a TypeError. The wallet helpers below stay for the same
     reason. */
  var REDEEM_UNAVAILABLE = "Alt-Points redemption is not available yet.";

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
    var shop =
      (root.YL_PRODUCTS && root.YL_PRODUCTS.shop) ||
      (typeof window !== "undefined" && window.YL_PRODUCTS && window.YL_PRODUCTS.shop) ||
      {};
    var raw = shop.freeShippingThreshold;
    if (raw === null || raw === undefined || raw === "") return DEFAULT_FREE_SHIP;
    var dollars = Number(raw);
    if (!isFinite(dollars)) return DEFAULT_FREE_SHIP;
    return dollars > 0 ? dollars : 0;
  }

  function money(n) {
    return "$" + (Math.round(n * 100) / 100).toFixed(2);
  }

  /* Multi-tier shipping and reward milestones from products.json
     shop.shippingMilestones. Fall back to single-tier free shipping threshold
     if missing or invalid. */
  function getShippingMilestones() {
    var shop =
      (root.YL_PRODUCTS && root.YL_PRODUCTS.shop) ||
      (typeof window !== "undefined" && window.YL_PRODUCTS && window.YL_PRODUCTS.shop) ||
      {};
    var raw = shop.shippingMilestones;
    if (Array.isArray(raw) && raw.length > 0) {
      var valid = [];
      for (var i = 0; i < raw.length; i++) {
        var item = raw[i];
        if (item && typeof item === "object") {
          var t = Number(item.threshold);
          if (isFinite(t) && t > 0) {
            valid.push({
              threshold: t,
              reward: String(item.reward || "Reward").trim(),
              icon: String(item.icon || "truck").trim()
            });
          }
        }
      }
      if (valid.length > 0) {
        valid.sort(function (a, b) {
          return a.threshold - b.threshold;
        });
        return valid;
      }
    }
    var defThreshold = freeShipThreshold();
    return [{ threshold: defThreshold, reward: "Free Tracked Shipping", icon: "truck" }];
  }

  function calculateMilestoneStatus(physSub, milestones, isPickup) {
    var list =
      Array.isArray(milestones) && milestones.length > 0 ? milestones : getShippingMilestones();
    var maxThreshold = list.length > 0 ? list[list.length - 1].threshold : 0;

    if (isPickup) {
      return {
        message: "Local SC Market Pick-up Selected ($0 Shipping)",
        progressPercent: 100,
        nextMilestone: null,
        remaining: 0,
        isAllUnlocked: true,
        milestones: list,
        maxThreshold: maxThreshold
      };
    }

    if (maxThreshold <= 0) {
      return {
        message: "",
        progressPercent: 0,
        nextMilestone: null,
        remaining: 0,
        isAllUnlocked: false,
        milestones: list,
        maxThreshold: 0
      };
    }

    var currentSub = Math.max(0, Number(physSub) || 0);
    var nextMilestone = null;
    var nextIndex = -1;

    for (var i = 0; i < list.length; i++) {
      if (currentSub < list[i].threshold) {
        nextMilestone = list[i];
        nextIndex = i;
        break;
      }
    }

    var pct = Math.min(100, Math.round((currentSub / maxThreshold) * 100));

    if (!nextMilestone) {
      /* The reward names come from products.json shop.shippingMilestones (the
         same list the pins and the countdown copy read, and the same list the
         Worker adds the $0 gift line item from). Hardcoding the top reward
         here meant renaming it in the CMS changed every string in the drawer
         except this one, so the celebration promised a gift the order no
         longer came with. */
      var bonusRewards = list.slice(1).map(function (m) {
        var label = String(m.reward || "").trim();
        if (!label) return "";
        return label.toLowerCase().indexOf("free ") === 0 ? label : "Free " + label;
      });
      var allMsg =
        list.length > 1
          ? "🎉 All perks unlocked! Free Shipping" +
            (bonusRewards.filter(Boolean).length
              ? " + " + bonusRewards.filter(Boolean).join(" + ")
              : "") +
            "!"
          : "🎉 You've unlocked " +
            (list[0].reward.toLowerCase().indexOf("free") === 0
              ? list[0].reward.toLowerCase()
              : list[0].reward) +
            "!";
      return {
        message: allMsg,
        progressPercent: 100,
        nextMilestone: null,
        remaining: 0,
        isAllUnlocked: true,
        milestones: list,
        maxThreshold: maxThreshold
      };
    }

    var remaining = Math.round((nextMilestone.threshold - currentSub) * 100) / 100;
    var msg = "";
    if (nextIndex === 0) {
      msg = "Add " + money(remaining) + " for " + nextMilestone.reward + "!";
    } else {
      var rewardLabel = nextMilestone.reward;
      if (rewardLabel.toLowerCase().indexOf("free ") !== 0) {
        rewardLabel = "Free " + rewardLabel;
      }
      msg = "Add " + money(remaining) + " more to unlock a " + rewardLabel + "!";
    }

    return {
      message: msg,
      progressPercent: pct,
      nextMilestone: nextMilestone,
      remaining: remaining,
      isAllUnlocked: false,
      milestones: list,
      maxThreshold: maxThreshold
    };
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
      normalizeGiftCardCode: normalizeGiftCardCode,
      generateShareCartUrl: generateShareCartUrl,
      parseSharedCartParam: parseSharedCartParam,
      getWalletPoints: getWalletPoints,
      setWalletPoints: setWalletPoints,
      freeShipThreshold: freeShipThreshold,
      getShippingMilestones: getShippingMilestones,
      calculateMilestoneStatus: calculateMilestoneStatus,
      money: money,
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
    isPickup: false,
    pickupMarket: "",
    storageNotice: "",
    shareCartNotice: ""
  };

  var GC_STORAGE_KEY = "yl_applied_gift_card";
  var GIFT_ORDER_KEY = "yl_is_gift_order";
  var GIFT_MESSAGE_KEY = "yl_gift_message";
  var PICKUP_KEY = "yl_cart_is_pickup";
  var PICKUP_MARKET_KEY = "yl_cart_pickup_market";

  /* Every key load() reads. A `storage` event on any of them means another
     tab changed something this drawer renders. */
  var SYNCED_KEYS = [
    STORAGE_KEY,
    GC_STORAGE_KEY,
    GIFT_ORDER_KEY,
    GIFT_MESSAGE_KEY,
    PICKUP_KEY,
    PICKUP_MARKET_KEY
  ];

  /* Ids the catalog will never list: a build-your-own box is priced by the
     Worker from its contents, and the gift card is a fixed SKU. */
  var PSEUDO_ITEM_IDS = ["custom-box", GIFT_CARD_ID];

  /* Shown when there are no upcoming markets to choose from (see render()). */
  var FALLBACK_PICKUP_LABEL = "Landrum SC Farmers Market (Saturdays 9am-12pm)";

  function pickupLabelFor(evt) {
    if (!evt) return "";
    return (
      (evt.name || "Pop-up Market") +
      " — " +
      (evt.dateLabel || "") +
      " (" +
      (evt.location || "Landrum, SC") +
      ")"
    );
  }

  function upcomingPickupEvents() {
    return root.YL_EVENTS && Array.isArray(root.YL_EVENTS.upcoming) ? root.YL_EVENTS.upcoming : [];
  }

  /* Cart storage was a bare JSON array, which left no room to say anything
     about the payload -- including which version wrote it. It is now
     {version, items}; a bare array is still read (and rewritten on the next
     save) so a returning shopper never loses the cart they left. */
  function parseStoredCart(raw) {
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.items)) return parsed.items;
    return [];
  }

  /* localStorage is shopper-writable and outlives the catalog: a discontinued
     product, a hand-edited entry, or a line written by a much older build can
     all still be sitting there. Anything that isn't a real, priceable line
     the Worker would accept is dropped here rather than rendered as NaN,
     crashed on, or POSTed to checkout only to be rejected. */
  function knownItemIds() {
    var catalog = getCatalog();
    var products = catalog && Array.isArray(catalog.products) ? catalog.products : null;
    /* No catalog on this page (or not loaded yet) is not evidence that an
       item is gone -- validate ids only when there is something to validate
       against. */
    if (!products || !products.length) return null;
    var bundles = catalog && Array.isArray(catalog.bundles) ? catalog.bundles : [];
    var ids = Object.create(null);
    products.forEach(function (prod) {
      if (prod && prod.id) ids[prod.id] = true;
    });
    bundles.forEach(function (b) {
      if (b && b.id) {
        ids[b.id] = true;
        ids["bundle-" + b.id] = true;
      }
    });
    PSEUDO_ITEM_IDS.forEach(function (id) {
      ids[id] = true;
    });
    return ids;
  }

  function sanitizeStoredItems(rawItems) {
    var known = knownItemIds();
    var kept = [];
    var dropped = 0;
    (Array.isArray(rawItems) ? rawItems : []).forEach(function (it) {
      if (!it || typeof it !== "object" || Array.isArray(it)) {
        dropped++;
        return;
      }
      if (typeof it.id !== "string" || !it.id.trim()) {
        dropped++;
        return;
      }
      var price = Number(it.price);
      if (!isFinite(price) || price < 0) {
        dropped++;
        return;
      }
      if (known && !known[it.id]) {
        dropped++;
        return;
      }
      it.price = price;
      it.qty = clampQty(it.qty, it.maxQty);
      kept.push(it);
    });
    return { items: kept, dropped: dropped };
  }

  function load() {
    var dropped = 0;
    try {
      var cleaned = sanitizeStoredItems(parseStoredCart(localStorage.getItem(STORAGE_KEY)));
      state.items = cleaned.items;
      dropped = cleaned.dropped;
    } catch {
      state.items = [];
    }
    try {
      var rawGC = localStorage.getItem(GC_STORAGE_KEY);
      state.appliedGiftCard = normalizeGiftCard(rawGC ? JSON.parse(rawGC) : null);
    } catch {
      state.appliedGiftCard = null;
    }
    try {
      state.isGiftOrder = localStorage.getItem(GIFT_ORDER_KEY) === "true";
      state.giftMessage = localStorage.getItem(GIFT_MESSAGE_KEY) || "";
    } catch {
      state.isGiftOrder = false;
      state.giftMessage = "";
    }
    /* Pick-up used to live only in memory, so choosing "collect at the market"
       and then reloading (or coming back from a product page) silently put the
       order back on shipping. It persists now -- and the stored market label is
       re-checked against the events the site is currently advertising, because
       the Worker validates that label too and a saved date that has since
       passed would fail checkout with nothing on screen explaining why. */
    try {
      state.isPickup = localStorage.getItem(PICKUP_KEY) === "true";
      state.pickupMarket = localStorage.getItem(PICKUP_MARKET_KEY) || "";
    } catch {
      state.isPickup = false;
      state.pickupMarket = "";
    }
    var upcoming = upcomingPickupEvents();
    if (state.pickupMarket && upcoming.length) {
      var validLabels = upcoming.map(pickupLabelFor);
      validLabels.push(FALLBACK_PICKUP_LABEL);
      if (validLabels.indexOf(state.pickupMarket) === -1) {
        /* Stale market: keep the pick-up preference, drop the dead date so
           render() re-selects the next real one. */
        state.pickupMarket = "";
      }
    }

    if (dropped > 0) {
      state.loadNotice = "Removed " + dropped + " unavailable item(s) from your cart";
      save();
    } else {
      state.loadNotice = "";
    }
  }

  function isQuotaError(err) {
    if (!err) return false;
    return (
      err.name === "QuotaExceededError" ||
      err.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      err.code === 22 ||
      err.code === 1014
    );
  }

  function save() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: STORAGE_VERSION, items: state.items })
      );
      state.storageNotice = "";
    } catch (err) {
      /* Storage full or blocked -- the cart still works for this page view,
         it just won't survive a reload. Say so once, quietly, rather than
         letting the shopper discover it after closing the tab. */
      if (isQuotaError(err)) {
        state.storageNotice = "Cart saved for this visit only — this device's storage is full.";
      }
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
        localStorage.setItem(GIFT_ORDER_KEY, "true");
      } else {
        localStorage.removeItem(GIFT_ORDER_KEY);
      }
      if (state.giftMessage) {
        localStorage.setItem(GIFT_MESSAGE_KEY, state.giftMessage);
      } else {
        localStorage.removeItem(GIFT_MESSAGE_KEY);
      }
      if (state.isPickup) {
        localStorage.setItem(PICKUP_KEY, "true");
      } else {
        localStorage.removeItem(PICKUP_KEY);
      }
      if (state.isPickup && state.pickupMarket) {
        localStorage.setItem(PICKUP_MARKET_KEY, state.pickupMarket);
      } else {
        localStorage.removeItem(PICKUP_MARKET_KEY);
      }
    } catch {
      /* storage full / blocked */
    }
  }

  /* Only ever store what the drawer and the Worker actually use. The balance
     endpoint also returns formattedBalance, initialAmount and friends; none of
     that belongs in localStorage, where it would go stale the moment the card
     is spent anywhere else. */
  function normalizeGiftCard(gc) {
    if (!gc || typeof gc !== "object") return null;
    if (gc.valid === false) return null;
    var code = typeof gc.code === "string" ? normalizeGiftCardCode(gc.code) : "";
    var balance = Number(gc.balance);
    if (!code || !isFinite(balance) || balance <= 0) return null;
    return { code: code, balance: Math.round(balance * 100) / 100, valid: true };
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

  var drawer, itemsEl, footEl, liveEl, dispatchEl, dispatchLiveEl;
  var lastDispatchMessage = null;

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
        /* A disabled Apply button or a collapsed gift-note textarea still
           matches the selector but cannot take focus, so trapping against
           them dumped focus out of the drawer at exactly the wrong moment.
           Keep only controls that can actually receive it. */
        var focusables = Array.prototype.filter.call(
          drawer.querySelectorAll(
            'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          ),
          isFocusable
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

    /* The dispatch countdown re-renders on every drawer render, and it used to
       carry aria-live itself: replacing the node re-announced "Order in next
       3h 04m..." after every quantity change. The visible badge is now inert
       and this separate region -- which render() never rebuilds -- is written
       to only when the message actually changes. */
    dispatchLiveEl = document.createElement("div");
    dispatchLiveEl.className = "sr-only";
    dispatchLiveEl.setAttribute("aria-live", "polite");
    document.body.appendChild(dispatchLiveEl);
  }

  function isFocusable(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.hidden) return false;
    if (typeof el.getAttribute === "function" && el.getAttribute("aria-hidden") === "true") {
      return false;
    }
    /* Anything display:none (the collapsed gift-card form, the hidden market
       picker) has no layout boxes. Environments without layout -- unit tests,
       jsdom -- don't implement getClientRects, so absence of the method is
       treated as "visible" rather than "hidden". */
    if (typeof el.getClientRects === "function" && el.getClientRects().length === 0) return false;
    return true;
  }

  /* Re-render replaces every node in the footer, which drops focus to
     <body> -- a keyboard user toggling pick-up lost their place and a screen
     reader went silent. Put focus back on the control that was just used. */
  function restoreFooterFocus(selector) {
    if (!footEl) return;
    var el = footEl.querySelector(selector);
    if (!el || typeof el.focus !== "function") return;
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
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
          '<div class="yl-cart-dispatch-badge">' +
          '<svg class="yl-cart-icon yl-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg> ' +
          "<span>" +
          escapeHtml(status.message) +
          "</span>" +
          "</div>";
        dispatchEl.style.display = "block";
        if (dispatchLiveEl && status.message !== lastDispatchMessage) {
          lastDispatchMessage = status.message;
          dispatchLiveEl.textContent = status.message;
        }
      } else {
        dispatchEl.innerHTML = "";
        dispatchEl.style.display = "none";
        if (dispatchLiveEl && lastDispatchMessage !== "") {
          lastDispatchMessage = "";
          dispatchLiveEl.textContent = "";
        }
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

        /* --hide is a border/divider token; as text colour it rendered these
           two lines at roughly 2:1 against the drawer. --paper-dim is the
           site's muted *text* token and clears AA. */
        var recipientText = it.giftRecipientEmail
          ? '<span class="yl-cart-recipient" style="display:block; font-size:0.75rem; color:var(--paper-dim);">For: ' +
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
          escapeHtml(it.qty) +
          "</span>" +
          '<button type="button" data-cart-action="inc" data-key="' +
          escapeAttr(key) +
          '" aria-label="Increase quantity"' +
          (it.maxQty && it.qty >= it.maxQty ? " disabled" : "") +
          ">+</button>" +
          "</div>" +
          '<div class="yl-cart-price-block">' +
          (isDiscounted
            ? '<div style="display:flex; align-items:baseline; gap:4px; justify-content:flex-end;"><s style="color:var(--paper-dim); font-size:0.85em;">' +
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
    var milestoneStatus = calculateMilestoneStatus(
      physSub,
      getShippingMilestones(),
      state.isPickup
    );
    var shipHTML = "";
    if (milestoneStatus.message) {
      var pinsHTML = "";
      if (milestoneStatus.milestones && milestoneStatus.maxThreshold > 0) {
        pinsHTML = milestoneStatus.milestones
          .map(function (m) {
            var pinPos = Math.min(
              100,
              Math.max(0, (m.threshold / milestoneStatus.maxThreshold) * 100)
            );
            var isReached = state.isPickup || physSub >= m.threshold;
            var pinIcon =
              m.icon === "gift"
                ? '<svg class="yl-cart-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="18" height="4" rx="1"></rect><path d="M12 8v13"></path><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"></path><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 4.8 0 0 1 12 8a4.8 4.8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5Z"></path></svg>'
                : m.icon === "sparkle"
                  ? '<svg class="yl-cart-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"></path></svg>'
                  : m.icon === "heart"
                    ? '<svg class="yl-cart-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"></path></svg>'
                    : '<svg class="yl-cart-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"></path><circle cx="7" cy="18" r="2"></circle><circle cx="17" cy="18" r="2"></circle><path d="M15 18H9"></path><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14v10Z"></path></svg>';
            return (
              '<div class="yl-cart-milestone-pin' +
              (isReached ? " is-reached" : "") +
              '" style="left:' +
              pinPos.toFixed(2) +
              '%" title="' +
              escapeHtml(m.reward) +
              '">' +
              pinIcon +
              "<span>$" +
              m.threshold +
              "</span></div>"
            );
          })
          .join("");
      }

      var headerIcon = state.isPickup
        ? '<svg class="yl-cart-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg>'
        : milestoneStatus.isAllUnlocked
          ? '<svg class="yl-cart-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"></path></svg>'
          : milestoneStatus.nextMilestone && milestoneStatus.nextMilestone.icon === "gift"
            ? '<svg class="yl-cart-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="18" height="4" rx="1"></rect><path d="M12 8v13"></path><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"></path><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 4.8 0 0 1 12 8a4.8 4.8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5Z"></path></svg>'
            : '<svg class="yl-cart-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"></path><circle cx="7" cy="18" r="2"></circle><circle cx="17" cy="18" r="2"></circle><path d="M15 18H9"></path><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14v10Z"></path></svg>';

      shipHTML =
        '<div class="yl-cart-milestones yl-cart-ship" role="progressbar" aria-valuenow="' +
        physSub +
        '" aria-valuemin="0" aria-valuemax="' +
        milestoneStatus.maxThreshold +
        '" aria-label="Shipping and reward milestones">' +
        '<div class="yl-cart-milestones-msg yl-cart-ship-msg">' +
        headerIcon +
        " " +
        escapeHtml(milestoneStatus.message) +
        "</div>" +
        '<div class="yl-cart-milestones-track yl-cart-ship-bar">' +
        '<div class="yl-cart-milestones-fill" style="width:' +
        milestoneStatus.progressPercent +
        '%"></div>' +
        pinsHTML +
        "</div>" +
        "</div>";
    }

    var siteCfg = (root.YL_CONTENT && root.YL_CONTENT.site) || {};
    var enableGiftOrders = siteCfg.enableGiftOrders !== false;
    var enableShareCart = siteCfg.enableShareCart !== false;

    /* Nothing credits Alt-Points and nothing redeems them: the earn promise
       ("You'll earn 36 Alt-Points with this order!") was never kept, and the
       redeem buttons called an endpoint that now answers 410. Both are gone.
       The wallet balance stays visible so anyone holding points can still see
       them, and the helpers stay exported. */
    var loyalty = getLoyaltyConfig();
    var loyaltyHTML = "";
    if (loyalty.enabled) {
      var walletBalance = getWalletPoints();
      loyaltyHTML =
        '<div class="yl-cart-loyalty-card">' +
        '  <div class="yl-cart-wallet-block">' +
        '    <div class="yl-cart-wallet-header">' +
        '      <span class="yl-cart-wallet-title">' +
        escapeHtml(loyalty.name) +
        " Wallet:</span>" +
        '      <span class="yl-cart-wallet-balance" id="yl-loyalty-wallet-balance"><strong>' +
        walletBalance +
        "</strong> " +
        escapeHtml(loyalty.name) +
        "</span>" +
        "    </div>" +
        "  </div>" +
        "</div>";
    }

    var pickupHTML = "";
    if (
      !root.YL_CONTENT ||
      !root.YL_CONTENT.site ||
      root.YL_CONTENT.site.enableLocalPickup !== false
    ) {
      var upcomingEvts = upcomingPickupEvents();

      /* Resolve the selected market first: the option list marks its selection
         from state.pickupMarket, so defaulting afterwards (as this used to)
         rendered a list with nothing selected while state claimed a market --
         the shopper saw the first market and checkout was sent whatever
         state happened to hold. */
      if (!state.pickupMarket) {
        state.pickupMarket = upcomingEvts[0]
          ? pickupLabelFor(upcomingEvts[0])
          : FALLBACK_PICKUP_LABEL;
      }

      var optionsHTML = upcomingEvts
        .map(function (evt) {
          var label = pickupLabelFor(evt);
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
          '<option value="' +
          escapeAttr(FALLBACK_PICKUP_LABEL) +
          '" selected>' +
          escapeHtml(FALLBACK_PICKUP_LABEL) +
          "</option>";
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
      /* Both of these come from products.json shop.volumePricing, which is
         CMS-editable, so they are untrusted text like any other content
         field -- not markup. */
      var catNoun =
        rule.category === "salves"
          ? "salve"
          : rule.category === "soaks"
            ? "soak"
            : escapeHtml(rule.category);
      var variantPart = rule.qualifyingVariant ? escapeHtml(rule.qualifyingVariant) + " " : "";
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
          milestoneStatus.remaining > 0 && !state.isPickup && milestoneStatus.maxThreshold > 0
            ? " · Add " + money(milestoneStatus.remaining) + " for FREE SHIPPING!"
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

    /* The drawer quoted a subtotal and nothing else, so a $28 order read as
       $28 right up until Stripe added $10 of shipping on the next screen.
       Same rule as workers/checkout.js: free at or above the threshold, free
       on pick-up, free when there is nothing physical to ship (gift cards are
       emailed), $10 otherwise. A threshold of 0 means the promise is switched
       off, so nothing qualifies. */
    var shipThreshold = freeShipThreshold();
    var shippingCost =
      physSub > 0 && !state.isPickup && !(shipThreshold > 0 && physSub >= shipThreshold)
        ? FLAT_SHIPPING
        : 0;

    /* The Worker caps the gift-card coupon at totalCents + shippingCents, so
       cap it against the same number here -- capping on the subtotal alone
       under-applied the card by up to $10 in the drawer and then "found" the
       difference at checkout. */
    var gcDiscount = 0;
    if (state.appliedGiftCard && state.appliedGiftCard.balance) {
      gcDiscount =
        Math.round(Math.min(sub + shippingCost, Number(state.appliedGiftCard.balance) || 0) * 100) /
        100;
    }
    var estimatedTotal = Math.max(0, Math.round((sub + shippingCost - gcDiscount) * 100) / 100);

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
          /* maxlength allows for a pasted code carrying its own spacing --
             normalizeGiftCardCode strips it before the lookup. */
          '    <input type="text" class="yl-cart-giftcard-input" placeholder="YALL-XXXX-XXXX-XXXX" maxlength="24" aria-label="Gift card code">' +
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
      '<div class="yl-cart-subtotal yl-cart-total-shipping"><span>Shipping</span><strong>' +
      (shippingCost > 0 ? money(shippingCost) : "Free") +
      "</strong></div>" +
      (gcDiscount > 0
        ? '<div class="yl-cart-discount-line"><span>Gift Card Discount (' +
          escapeHtml(state.appliedGiftCard.code) +
          ")</span><strong>-" +
          money(gcDiscount) +
          "</strong></div>"
        : "") +
      /* "Total Due" promised a final number this page cannot know: sales tax
         is calculated by Stripe against the address collected at checkout. */
      '<div class="yl-cart-subtotal yl-cart-total-due" style="border-top: 1px solid rgba(255,255,255,0.1); margin-top: 6px; padding-top: 6px;"><span>Estimated total (before tax)</span><strong>' +
      money(estimatedTotal) +
      "</strong></div>";

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

    var storageNoticeHTML = state.storageNotice
      ? '<p class="yl-cart-storage-notice">' + escapeHtml(state.storageNotice) + "</p>"
      : "";

    footEl.innerHTML =
      upsellHTML() +
      volumeNudgesHTML +
      loyaltyHTML +
      giftOrderHTML +
      pickupHTML +
      shipHTML +
      giftCardHTML +
      totalsHTML +
      '<button type="button" class="btn btn-primary btn-block yl-cart-checkout"' +
      (checkoutInFlight ? " disabled" : "") +
      ">" +
      (checkoutInFlight ? "Redirecting…" : "Checkout") +
      "</button>" +
      shareCartHTML +
      storageNoticeHTML +
      '<p class="yl-cart-note">Promo codes, gift cards &amp; taxes applied at checkout.</p>';

    var checkoutBtn = footEl.querySelector(".yl-cart-checkout");
    if (checkoutBtn) {
      /* A render triggered while the checkout request is still in flight (a
         cross-tab storage event, a quantity change) used to hand back a fresh,
         enabled Checkout button -- a second click then opened a second Stripe
         session for the same cart. The disabled state belongs to the request,
         so re-apply it on every render, not just at click time. */
      if (checkoutInFlight) {
        checkoutBtn.disabled = true;
        checkoutBtn.textContent = "Redirecting…";
      } else {
        checkoutBtn.disabled = false;
        checkoutBtn.textContent = "Checkout";
      }
      checkoutBtn.addEventListener("click", checkout);
    }

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
          if (!applyGiftCard(data)) {
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

    var giftOrderCb = footEl.querySelector("#yl-cart-giftorder-checkbox");
    var giftMsgInput = footEl.querySelector("#yl-cart-giftmessage-input");
    if (giftOrderCb) {
      giftOrderCb.addEventListener("change", function () {
        state.isGiftOrder = giftOrderCb.checked;
        save();
        render();
        restoreFooterFocus("#yl-cart-giftorder-checkbox");
        announce(
          state.isGiftOrder ? "Gift order on. A gift note can be added below." : "Gift order off."
        );
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
        if (pickupSelect && pickupSelect.value) {
          state.pickupMarket = pickupSelect.value;
        }
        save();
        render();
        restoreFooterFocus("#yl-cart-pickup-checkbox");
        announce(
          state.isPickup
            ? "Local market pick-up selected. Shipping is free" +
                (state.pickupMarket ? ": " + state.pickupMarket : "") +
                "."
            : "Local market pick-up deselected. Shipping applies."
        );
      });
    }

    if (pickupSelect) {
      pickupSelect.addEventListener("change", function () {
        state.pickupMarket = pickupSelect.value;
        save();
        announce("Pick-up market set to " + state.pickupMarket + ".");
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

  /* One checkout request at a time, ever. The old guard was the button's own
     disabled attribute, which every re-render threw away: a storage event or
     a quantity change mid-request handed back an enabled button, and a second
     click created a second Stripe session (two holds on the same card, two
     order emails). The flag lives out here instead, where nothing can
     re-render it away, and render() reads it back. */
  var checkoutInFlight = false;
  var CHECKOUT_TIMEOUT_MS = 20000;
  var GENERIC_CHECKOUT_ERROR =
    "Sorry -- checkout isn't available right now. Please try again in a moment.";

  function checkout() {
    if (!state.items.length) return;
    if (checkoutInFlight) return;
    checkoutInFlight = true;

    var btn = footEl.querySelector(".yl-cart-checkout");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Redirecting…";
    }

    /* Without a deadline a hung Worker left the button on "Redirecting…"
       forever with no way back. */
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, CHECKOUT_TIMEOUT_MS);

    var opts = {
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
    };
    if (controller) opts.signal = controller.signal;

    function settle() {
      clearTimeout(timer);
      checkoutInFlight = false;
    }

    fetch(CHECKOUT_URL, opts)
      .then(function (res) {
        return readJsonSafely(res).then(function (data) {
          return { res: res, data: data };
        });
      })
      .then(function (out) {
        var res = out.res;
        var data = out.data;
        if (res && res.ok && data && data.url) {
          settle();
          window.location = data.url;
          return;
        }
        /* The Worker answers 400 with curated, shopper-safe text ("That gift
           card has already been used", "Pick-up market is no longer
           available"). Showing the house "try again in a moment" for those
           told the shopper to retry something that will never succeed.

           409 is the gift-card ledger refusing a stale balance: between the
           lookup that applied this card and this click, another tab or
           another holder of the same code spent it. It reads like a 400 to
           the shopper -- their own words, Checkout usable again -- but the
           card in state is worthless now and has to go with it, or every
           retry re-sends the same dead code and fails the same way forever.

           Any other status is an infrastructure problem whose message is not
           ours to show. */
        var status = res ? res.status : 0;
        var err = new Error("Checkout unavailable");
        if (
          (status === 400 || status === 409) &&
          data &&
          typeof data.error === "string" &&
          data.error.trim()
        ) {
          err.shopperMessage = data.error.trim();
        }
        if (status === 409) {
          err.clearGiftCard = true;
          if (!err.shopperMessage) err.shopperMessage = GIFT_CARD_CONFLICT;
        }
        throw err;
      })
      .catch(function (err) {
        settle();
        if (err && err.clearGiftCard) {
          /* save() drops yl_applied_gift_card with it, so a reload does not
             resurrect the spent card. */
          state.appliedGiftCard = null;
          state.giftCardOpen = false;
          state.giftCardError = "";
          save();
        }
        /* render() re-enables the button from checkoutInFlight, so the drawer
           recovers even if this render replaced the node the click came
           from. */
        render();
        var msg = (err && err.shopperMessage) || GENERIC_CHECKOUT_ERROR;
        announce("Checkout error: " + msg);
        showCheckoutError(msg);
      });
  }

  function clear() {
    state.items = [];
    state.isGiftOrder = false;
    state.giftMessage = "";
    /* An emptied cart used to keep its applied gift card, so the next order
       opened with someone else's (or an already-spent) code attached and a
       discount line against a $0 subtotal. save() drops the key with it. */
    state.appliedGiftCard = null;
    state.giftCardOpen = false;
    state.giftCardError = "";
    state.storageNotice = "";
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

  /* The one supported way to attach a gift card to the cart. gift-card.js
     used to write yl_applied_gift_card straight into localStorage and hope
     the drawer picked it up: it stored the whole balance response, it wrote
     an unvalidated shape, and in the same tab nothing re-read storage, so the
     card only appeared after a reload. */
  function applyGiftCard(gc) {
    var normalized = normalizeGiftCard(gc);
    if (!normalized) return false;
    state.appliedGiftCard = normalized;
    state.giftCardOpen = false;
    state.giftCardError = "";
    save();
    render();
    announce(
      "Gift card " + normalized.code + " applied (" + money(normalized.balance) + " available)"
    );
    return true;
  }

  /* Kept on the public surface so an old inline handler or a cached page
     gets a rejected promise rather than a TypeError. It never touches the
     network: redeem-points answers 410 and mints nothing, and deducting the
     wallet balance for a voucher that will never exist is worse than doing
     nothing at all. */
  function redeemLoyaltyPoints() {
    return Promise.reject(new Error(REDEEM_UNAVAILABLE));
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
    if (state.loadNotice) {
      announce(state.loadNotice);
      state.loadNotice = "";
    }

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
    /* Only the items key was watched, so applying a gift card or ticking
       "this is a gift" in one tab left every other tab showing the old
       totals -- and a null key (localStorage.clear()) went unnoticed
       entirely. Re-read on anything load() reads. */
    window.addEventListener("storage", function (e) {
      if (!e || e.key === null || e.key === undefined || SYNCED_KEYS.indexOf(e.key) !== -1) {
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
    applyGiftCard: applyGiftCard,
    normalizeGiftCardCode: normalizeGiftCardCode,
    getWalletPoints: getWalletPoints,
    setWalletPoints: setWalletPoints,
    redeemLoyaltyPoints: redeemLoyaltyPoints,
    restoreCartFromUrl: restoreCartFromUrl,
    parseSharedCartParam: parseSharedCartParam,
    getShippingMilestones: getShippingMilestones,
    calculateMilestoneStatus: calculateMilestoneStatus,
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
