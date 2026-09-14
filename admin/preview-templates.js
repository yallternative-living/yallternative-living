/* eslint-env browser, node */
/**
 * @fileoverview Sveltia CMS Live Preview Templates for Y'allternative Living.
 *
 * Implements real-time product card previews in the Sveltia CMS split-pane
 * editor using Sveltia's built-in React-compatible preview engine
 * (window.createClass, window.h, window.CMS.registerPreviewTemplate).
 *
 * Stylistically mirrors the storefront product cards on shop.html and
 * index.html with 100% fidelity using the storefront's native stylesheet
 * (assets/css/styles.css) and preview container layout (admin/preview.css).
 *
 * Hardened against adversarial inputs:
 * - Prototype pollution defense (Object.prototype.hasOwnProperty guard on maps)
 * - Safe protocol validation (blocks javascript:, vbscript:, data:text/html)
 * - Clamped, non-negative price math (handles NaN, Infinity, and negative deltas)
 * - Strict type checking on strings, arrays, ratings, variants, and ingredients
 * - Gallery dot cap (prevents DOM overflow on massive image arrays)
 *
 * @see https://sveltiacms.app/en/docs/api/preview-templates
 * @see https://sveltiacms.app/en/docs/api/preview-styles
 */
(function () {
  "use strict";

  var root = typeof window !== "undefined" ? window : (typeof global !== "undefined" ? global : this);

  if (!root.CMS || typeof root.CMS.registerPreviewTemplate !== "function") {
    if (typeof module === "undefined") return;
  }
  if (typeof root.createClass !== "function" || typeof root.h !== "function") {
    if (typeof module === "undefined") return;
  }

  var h = root.h;
  var createClass = root.createClass;

  // Register storefront and preview stylesheets with Sveltia CMS preview frame
  if (root.CMS && typeof root.CMS.registerPreviewStyle === "function") {
    root.CMS.registerPreviewStyle("/assets/css/styles.css");
    root.CMS.registerPreviewStyle("/admin/preview.css");
  }

  var CATEGORY_MAP = {
    apparel: "Apparel",
    salves: "Salves & Balms",
    body: "Body & Skin",
    soaks: "Bath Soaks",
    potions: "Potions & Spellwork",
    ritual: "Ritual & Home",
    "gift-sets": "Gift Sets",
    "gift-cards": "Gift Cards"
  };

  var TAG_MAP = {
    vegan: "Vegan",
    "sensitive-safe": "Sensitive Skin Safe",
    unscented: "Unscented",
    "essential-oil-free": "Essential Oil Free",
    "cruelty-free": "Cruelty-Free",
    bestseller: "Bestseller"
  };

  var PLACEHOLDER_IMAGE = "/assets/img/placeholder-coming-soon-1200.png";
  var MAX_GALLERY_DOTS = 8;
  var MAX_INGREDIENTS = 100;
  var MAX_TAG_PILLS = 20;

  /**
   * Sanitizes image URLs to prevent script execution via dangerous protocols.
   * Only allows relative paths, http(s), blob, or data:image/* schemes.
   *
   * @param {string} rawUrl
   * @returns {string} Safe image URL or fallback placeholder
   */
  function sanitizeImageUrl(rawUrl) {
    if (typeof rawUrl !== "string") return PLACEHOLDER_IMAGE;
    var url = rawUrl.trim();
    if (!url) return PLACEHOLDER_IMAGE;

    // Block dangerous URI schemes (javascript:, vbscript:, data:text/html, etc.)
    if (/^(?:javascript|vbscript):/i.test(url) || /^(?!data:image\/)data:/i.test(url)) {
      return PLACEHOLDER_IMAGE;
    }

    // Ensure relative paths have leading slash for predictable preview resolution
    if (
      !url.startsWith("/") &&
      !url.startsWith("http://") &&
      !url.startsWith("https://") &&
      !url.startsWith("blob:") &&
      !url.startsWith("data:image/")
    ) {
      url = "/" + url;
    }
    return url;
  }

  /**
   * Product Card Live Preview Component
   */
  var ProductPreview = createClass({
    getInitialState: function () {
      return {
        activeImageIndex: 0,
        selectedVariantIndex: 0
      };
    },

    render: function () {
      var self = this;
      var entry = this.props && this.props.entry;
      var data =
        entry && typeof entry.toJS === "function" ? entry.toJS().data : (entry && entry.data) || {};

      if (!data || typeof data !== "object") {
        data = {};
      }

      var getAsset = this.props && this.props.getAsset;

      // 1. Product Images & Gallery
      var rawImages = [];
      if (typeof data.image === "string" && data.image.trim()) {
        rawImages.push(data.image.trim());
      }
      if (Array.isArray(data.images)) {
        data.images.forEach(function (img) {
          if (typeof img === "string" && img.trim() && rawImages.indexOf(img.trim()) === -1) {
            rawImages.push(img.trim());
          }
        });
      }

      var resolvedImages = rawImages
        .map(function (imgPath) {
          var asset = typeof getAsset === "function" ? getAsset(imgPath) : null;
          var url = asset ? asset.url || asset.toString() : imgPath;
          return sanitizeImageUrl(url);
        })
        .filter(Boolean);

      if (!resolvedImages.length) {
        resolvedImages.push(PLACEHOLDER_IMAGE);
      }

      var activeIdx = parseInt(this.state && this.state.activeImageIndex, 10) || 0;
      if (activeIdx < 0 || activeIdx >= resolvedImages.length) {
        activeIdx = 0;
      }
      var currentImage = resolvedImages[activeIdx];

      var galleryDots = null;
      if (resolvedImages.length > 1) {
        var displayCount = Math.min(resolvedImages.length, MAX_GALLERY_DOTS);
        var dots = [];
        for (var dIdx = 0; dIdx < displayCount; dIdx++) {
          (function (idx) {
            dots.push(
              h("button", {
                key: idx,
                type: "button",
                className: "card-gallery-dot" + (idx === activeIdx ? " active" : ""),
                "aria-label": "View photo " + (idx + 1) + " of " + resolvedImages.length,
                onClick: function (e) {
                  e.preventDefault();
                  self.setState({ activeImageIndex: idx });
                }
              })
            );
          })(dIdx);
        }
        galleryDots = h("div", { className: "card-gallery-dots" }, dots);
      }

      // 2. Category Eyebrow (Prototype-safe lookup)
      var catLabel = "Apothecary";
      if (typeof data.category === "string" && data.category.length > 0) {
        if (Object.prototype.hasOwnProperty.call(CATEGORY_MAP, data.category)) {
          catLabel = CATEGORY_MAP[data.category];
        } else {
          catLabel = data.category;
        }
      }

      // 3. Tag Pills (Prototype-safe lookup, sanitized children)
      var tagPills = null;
      if (Array.isArray(data.tags) && data.tags.length > 0) {
        var pills = data.tags
          .filter(function (tagKey) {
            return typeof tagKey === "string" && tagKey.length > 0;
          })
          .slice(0, MAX_TAG_PILLS)
          .map(function (tagKey) {
            var tagLabel = Object.prototype.hasOwnProperty.call(TAG_MAP, tagKey)
              ? TAG_MAP[tagKey]
              : tagKey;
            return h("span", { className: "tag-pill", key: tagKey }, String(tagLabel));
          });
        if (pills.length > 0) {
          tagPills = h("div", { className: "tag-pills" }, pills);
        }
      }

      // 4. Star Rating (Safe number parsing & bounds clamping)
      var ratingEl = null;
      if (data.rating && typeof data.rating === "object") {
        var ratingVal = Number(data.rating.value);
        var ratingCount = parseInt(data.rating.count, 10);
        if (!isFinite(ratingVal)) ratingVal = 5;
        if (!isFinite(ratingCount) || ratingCount < 1) ratingCount = 0;

        if (ratingCount >= 1) {
          ratingVal = Math.max(0, Math.min(5, ratingVal));
          var fullCount = Math.round(ratingVal);
          var stars = "★★★★★".slice(0, fullCount) + "☆☆☆☆☆".slice(fullCount, 5);
          var reviewSuffix = ratingCount === 1 ? " review" : " reviews";
          var ratingText = ratingVal.toFixed(1) + " · " + ratingCount + reviewSuffix;

          ratingEl = h(
            "div",
            { className: "card-rating" },
            h("span", { "aria-hidden": "true" }, stars),
            h("span", { className: "card-rating-count" }, ratingText)
          );
        }
      }

      // 5. Badges (Stock, Sale, Bestseller, Coming Soon)
      var isSoldOut =
        data.inStock === false ||
        (typeof data.stock === "number" && isFinite(data.stock) && data.stock <= 0);
      var badges = [];

      if (data.comingSoon) {
        badges.push(
          h("span", { className: "stock-badge low-stock", key: "comingSoon" }, "Coming Soon")
        );
        if (data.estimatedBatchDate) {
          badges.push(
            h(
              "span",
              { className: "stock-badge badge-batch-date", key: "batchDate" },
              "Batch: " + String(data.estimatedBatchDate)
            )
          );
        }
      } else if (isSoldOut) {
        badges.push(h("span", { className: "stock-badge sold-out", key: "soldOut" }, "Sold Out"));
      } else if (
        typeof data.stock === "number" &&
        isFinite(data.stock) &&
        data.stock > 0 &&
        data.stock <= 5
      ) {
        badges.push(
          h(
            "span",
            { className: "stock-badge low-stock", key: "lowStock" },
            "Only " + Math.floor(data.stock) + " left"
          )
        );
      }

      if (data.sale) {
        var saleLabel = "Sale";
        if (
          typeof data.sale === "object" &&
          typeof data.sale.label === "string" &&
          data.sale.label.trim()
        ) {
          saleLabel = data.sale.label.trim();
        }
        badges.push(h("span", { className: "stock-badge sale-badge", key: "sale" }, saleLabel));
      }

      var isBestseller = !!(
        data.bestseller ||
        (Array.isArray(data.tags) && data.tags.indexOf("bestseller") !== -1)
      );
      if (isBestseller) {
        badges.push(
          h("span", { className: "stock-badge bestseller-badge", key: "bestseller" }, "Bestseller")
        );
      }

      // 6. Variants Selector
      var variantOptions = [];
      if (data.variants && Array.isArray(data.variants.options)) {
        variantOptions = data.variants.options.filter(function (opt) {
          return opt && typeof opt === "object";
        });
      }
      var hasVariants = variantOptions.length > 0;
      var selectedOptIdx = parseInt(this.state && this.state.selectedVariantIndex, 10) || 0;
      if (selectedOptIdx < 0 || selectedOptIdx >= variantOptions.length) {
        selectedOptIdx = 0;
      }
      var selectedOption = hasVariants ? variantOptions[selectedOptIdx] : null;

      var variantPicker = null;
      if (hasVariants) {
        var optionsEls = variantOptions.map(function (opt, idx) {
          var label =
            typeof opt.label === "string" && opt.label.trim()
              ? opt.label.trim()
              : "Option " + (idx + 1);
          var suffix = opt.soldOut ? " — sold out" : "";
          return h(
            "option",
            { key: idx, value: idx, disabled: !!opt.soldOut },
            label + suffix
          );
        });
        variantPicker = h(
          "label",
          { className: "variant-select-wrap" },
          h(
            "span",
            { className: "variant-select-label" },
            (data.variants && typeof data.variants.name === "string" && data.variants.name.trim()) ||
              "Option"
          ),
          h(
            "select",
            {
              className: "variant-select",
              value: selectedOptIdx,
              onChange: function (e) {
                self.setState({ selectedVariantIndex: parseInt(e.target.value, 10) || 0 });
              }
            },
            optionsEls
          )
        );
      }

      // 7. Pricing Math (Clamped at >= 0, handles non-numeric & deltas)
      var basePrice = Number(data.price);
      if (!isFinite(basePrice) || basePrice < 0) {
        basePrice = 0;
      }

      var effectivePrice = basePrice;
      if (
        selectedOption &&
        typeof selectedOption.priceDelta === "number" &&
        isFinite(selectedOption.priceDelta)
      ) {
        effectivePrice = Math.max(0, basePrice + selectedOption.priceDelta);
      }

      var priceString = "$" + effectivePrice.toFixed(2);
      if (hasVariants && variantOptions.length > 1 && !selectedOption) {
        priceString = "From " + priceString;
      }

      var priceEl = h("span", { className: "price" }, priceString);
      var numOrigPrice = Number(data.originalPrice);
      if (data.sale && isFinite(numOrigPrice) && numOrigPrice > effectivePrice) {
        priceEl = h(
          "span",
          { className: "price" },
          priceString + " ",
          h("s", { className: "original-price" }, "$" + numOrigPrice.toFixed(2))
        );
      }

      // 8. Action Button
      var buttonText = "Add to Cart";
      var buttonClass = "btn btn-primary btn-sm";
      var buttonDisabled = false;
      if (data.comingSoon) {
        buttonText = "Coming Soon";
        buttonClass = "btn btn-outline btn-sm";
        buttonDisabled = true;
      } else if (isSoldOut || (selectedOption && selectedOption.soldOut)) {
        buttonText = "Sold Out";
        buttonClass = "btn btn-outline btn-sm";
        buttonDisabled = true;
      }
      var actionButton = h(
        "button",
        { type: "button", className: buttonClass, disabled: buttonDisabled },
        buttonText
      );

      // 9. Ingredients (Sanitized children, bounds capped)
      var ingredientsEl = null;
      if (Array.isArray(data.ingredients) && data.ingredients.length > 0) {
        var ingredientItems = data.ingredients
          .filter(function (item) {
            return item != null && typeof item !== "object";
          })
          .slice(0, MAX_INGREDIENTS)
          .map(function (item, idx) {
            return h("li", { key: idx }, String(item));
          });
        if (ingredientItems.length > 0) {
          ingredientsEl = h(
            "details",
            { className: "card-ingredients" },
            h(
              "summary",
              null,
              (typeof data.ingredientsLabel === "string" && data.ingredientsLabel.trim()) ||
                "Ingredients"
            ),
            h("ul", null, ingredientItems)
          );
        }
      }

      // 10. Title & Blurb (Type guarded to avoid React child object errors)
      var nameText =
        typeof data.name === "string" && data.name.trim() ? data.name : "Untitled Product";
      var blurbText =
        typeof data.blurb === "string" && data.blurb.trim()
          ? data.blurb
          : "No description provided yet.";

      // Assemble Product Card
      return h(
        "div",
        { className: "cms-preview-wrapper" },
        h(
          "div",
          { className: "cms-preview-header" },
          h(
            "svg",
            {
              width: 14,
              height: 14,
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: 2,
              strokeLinecap: "round",
              strokeLinejoin: "round",
              style: { marginRight: 4 }
            },
            h("circle", { cx: 12, cy: 12, r: 10 }),
            h("path", { d: "M12 8v4" }),
            h("path", { d: "m12 16 .01 0" })
          ),
          "Live Storefront Preview"
        ),
        h(
          "div",
          { className: "cms-preview-card-wrap" },
          h(
            "article",
            { className: "card" },
            h(
              "div",
              { className: "card-media" },
              h("img", {
                src: currentImage,
                alt: nameText,
                loading: "lazy"
              }),
              galleryDots
            ),
            h(
              "div",
              { className: "card-body" },
              h("span", { className: "card-cat" }, catLabel),
              tagPills,
              h(
                "h3",
                null,
                h(
                  "a",
                  {
                    className: "card-title-link",
                    href: "#",
                    onClick: function (e) {
                      e.preventDefault();
                    }
                  },
                  nameText
                )
              ),
              ratingEl,
              h("p", null, blurbText),
              ingredientsEl,
              badges.length > 0 ? h("div", { className: "card-badges-row" }, badges) : null,
              h(
                "div",
                { className: "card-foot" },
                variantPicker,
                h("div", { className: "card-foot-row" }, priceEl, actionButton)
              )
            )
          )
        )
      );
    }
  });

  if (root.CMS && typeof root.CMS.registerPreviewTemplate === "function") {
    root.CMS.registerPreviewTemplate("products", ProductPreview);
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      ProductPreview: ProductPreview,
      CATEGORY_MAP: CATEGORY_MAP,
      TAG_MAP: TAG_MAP,
      sanitizeImageUrl: sanitizeImageUrl
    };
  }
})();

