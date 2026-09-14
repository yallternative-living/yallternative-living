/* eslint-env browser */
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
 * @see https://sveltiacms.app/en/docs/api/preview-templates
 * @see https://sveltiacms.app/en/docs/api/preview-styles
 */
(function () {
  "use strict";

  if (!window.CMS || typeof window.CMS.registerPreviewTemplate !== "function") {
    return;
  }
  if (typeof window.createClass !== "function" || typeof window.h !== "function") {
    return;
  }

  var h = window.h;
  var createClass = window.createClass;

  // Register storefront and preview stylesheets with Sveltia CMS preview frame
  window.CMS.registerPreviewStyle("/assets/css/styles.css");
  window.CMS.registerPreviewStyle("/admin/preview.css");

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
      var entry = this.props.entry;
      var data =
        entry && typeof entry.toJS === "function" ? entry.toJS().data : (entry && entry.data) || {};

      var getAsset = this.props.getAsset;

      // 1. Product Images & Gallery
      var rawImages = [];
      if (data.image) rawImages.push(data.image);
      if (Array.isArray(data.images)) {
        data.images.forEach(function (img) {
          if (img && rawImages.indexOf(img) === -1) rawImages.push(img);
        });
      }

      var resolvedImages = rawImages.map(function (imgPath) {
        var asset = typeof getAsset === "function" ? getAsset(imgPath) : null;
        var url = asset ? asset.url || asset.toString() : imgPath;
        if (
          url &&
          !url.startsWith("/") &&
          !url.startsWith("http://") &&
          !url.startsWith("https://") &&
          !url.startsWith("blob:")
        ) {
          url = "/" + url;
        }
        return url;
      });

      if (!resolvedImages.length) {
        resolvedImages.push("/assets/img/placeholder-coming-soon-1200.png");
      }

      var activeIdx = this.state.activeImageIndex;
      if (activeIdx >= resolvedImages.length) activeIdx = 0;
      var currentImage = resolvedImages[activeIdx];

      var galleryDots = null;
      if (resolvedImages.length > 1) {
        var dots = resolvedImages.map(function (_, idx) {
          return h("button", {
            key: idx,
            type: "button",
            className: "card-gallery-dot" + (idx === activeIdx ? " active" : ""),
            "aria-label": "View photo " + (idx + 1) + " of " + resolvedImages.length,
            onClick: function (e) {
              e.preventDefault();
              self.setState({ activeImageIndex: idx });
            }
          });
        });
        galleryDots = h("div", { className: "card-gallery-dots" }, dots);
      }

      // 2. Category Eyebrow
      var catLabel = CATEGORY_MAP[data.category] || data.category || "Apothecary";

      // 3. Tag Pills
      var tagPills = null;
      if (Array.isArray(data.tags) && data.tags.length > 0) {
        var pills = data.tags.map(function (tagKey) {
          return h("span", { className: "tag-pill", key: tagKey }, TAG_MAP[tagKey] || tagKey);
        });
        tagPills = h("div", { className: "tag-pills" }, pills);
      }

      // 4. Star Rating
      var ratingEl = null;
      if (data.rating && typeof data.rating === "object" && Number(data.rating.count) >= 1) {
        var ratingVal = Number(data.rating.value) || 5;
        var ratingCount = Number(data.rating.count) || 1;
        var fullCount = Math.max(0, Math.min(5, Math.round(ratingVal)));
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

      // 5. Badges (Stock, Sale, Bestseller, Coming Soon)
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
              "Batch: " + data.estimatedBatchDate
            )
          );
        }
      } else if (data.inStock === false || data.stock === 0) {
        badges.push(h("span", { className: "stock-badge sold-out", key: "soldOut" }, "Sold Out"));
      } else if (typeof data.stock === "number" && data.stock <= 5) {
        badges.push(
          h(
            "span",
            { className: "stock-badge low-stock", key: "lowStock" },
            "Only " + data.stock + " left"
          )
        );
      }

      if (data.sale) {
        var saleLabel = typeof data.sale === "object" && data.sale.label ? data.sale.label : "Sale";
        badges.push(h("span", { className: "stock-badge sale-badge", key: "sale" }, saleLabel));
      }

      if (data.bestseller || (Array.isArray(data.tags) && data.tags.includes("bestseller"))) {
        badges.push(
          h("span", { className: "stock-badge bestseller-badge", key: "bestseller" }, "Bestseller")
        );
      }

      // 6. Variants Selector
      var hasVariants =
        data.variants && Array.isArray(data.variants.options) && data.variants.options.length > 0;
      var selectedOptIdx = this.state.selectedVariantIndex || 0;
      if (hasVariants && selectedOptIdx >= data.variants.options.length) {
        selectedOptIdx = 0;
      }
      var selectedOption = hasVariants ? data.variants.options[selectedOptIdx] : null;

      var variantPicker = null;
      if (hasVariants) {
        var optionsEls = data.variants.options.map(function (opt, idx) {
          var label = (opt && opt.label) || "Option " + (idx + 1);
          var suffix = opt && opt.soldOut ? " — sold out" : "";
          return h(
            "option",
            { key: idx, value: idx, disabled: !!(opt && opt.soldOut) },
            label + suffix
          );
        });
        variantPicker = h(
          "label",
          { className: "variant-select-wrap" },
          h(
            "span",
            { className: "variant-select-label" },
            (data.variants && data.variants.name) || "Option"
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

      // 7. Pricing
      var basePrice = parseFloat(data.price);
      if (isNaN(basePrice)) basePrice = 0;

      // Price calculation considering variant delta
      var effectivePrice = basePrice;
      if (selectedOption && typeof selectedOption.priceDelta === "number") {
        effectivePrice = basePrice + selectedOption.priceDelta;
      }

      var priceString = "$" + effectivePrice.toFixed(2);
      if (hasVariants && data.variants.options.length > 1 && !selectedOption) {
        priceString = "From " + priceString;
      }

      var priceEl = h("span", { className: "price" }, priceString);
      var numOrigPrice = parseFloat(data.originalPrice);
      if (data.sale && !isNaN(numOrigPrice) && numOrigPrice > effectivePrice) {
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
      } else if (
        data.inStock === false ||
        data.stock === 0 ||
        (selectedOption && selectedOption.soldOut)
      ) {
        buttonText = "Sold Out";
        buttonClass = "btn btn-outline btn-sm";
        buttonDisabled = true;
      }
      var actionButton = h(
        "button",
        { type: "button", className: buttonClass, disabled: buttonDisabled },
        buttonText
      );

      // 9. Ingredients (if present)
      var ingredientsEl = null;
      if (Array.isArray(data.ingredients) && data.ingredients.length > 0) {
        var ingredientItems = data.ingredients.map(function (item, idx) {
          return h("li", { key: idx }, item);
        });
        ingredientsEl = h(
          "details",
          { className: "card-ingredients" },
          h("summary", null, data.ingredientsLabel || "Ingredients"),
          h("ul", null, ingredientItems)
        );
      }

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
                alt: data.name || "Product image",
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
                  data.name || "Untitled Product"
                )
              ),
              ratingEl,
              h("p", null, data.blurb || "No description provided yet."),
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

  window.CMS.registerPreviewTemplate("products", ProductPreview);
})();
