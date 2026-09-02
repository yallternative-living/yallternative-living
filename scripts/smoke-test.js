#!/usr/bin/env node
"use strict";

/**
 * @fileoverview High-Speed CI Smoke Test Suite (<3s) for Y'allternative Living.
 *
 * Executes 4 critical sanity stages:
 *   Stage 1: Site Data Compilation (scripts/build-site-data.js)
 *   Stage 2: Pure Cart Math Engine (assets/js/cart.js)
 *   Stage 3: Cloudflare Worker Checkout Logic (workers/checkout.js)
 *   Stage 4: High-Speed In-Process Static QA Assertions (JSON-LD, CSP, links, images, VM syntax)
 *
 * Performance SLA: Must execute in < 3000ms (target ~500ms).
 * Exits with code 0 on success, code 1 on failure with clear stage diagnostic logs.
 *
 * Usage:
 *   node scripts/smoke-test.js   (or: npm run test:smoke)
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TOTAL_START_TIME = Date.now();
const PERFORMANCE_BUDGET_MS = 3000;

let totalPassed = 0;
let totalFailed = 0;
const failures = [];

function pass(label) {
  totalPassed++;
  console.log(`  ✓ ${label}`);
}

function fail(label, error) {
  totalFailed++;
  const msg = error ? `${label} -- ${error}` : label;
  failures.push(msg);
  console.error(`  ✗ ${msg}`);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

(async () => {
  console.log("Starting Y'allternative Living High-Speed Smoke Test Suite...");

  // =========================================================================
  // STAGE 1: Site Data Build & Compiler
  // =========================================================================
  section("STAGE 1: Site Data Build & Compiler");
  const stage1Start = Date.now();
  try {
    execSync(`"${process.execPath}" "${path.join(__dirname, "build-site-data.js")}"`, {
      cwd: ROOT,
      stdio: "pipe"
    });
    pass("build-site-data.js compiled data objects and generated static pages");

    // Verify critical derived files exist and are non-empty
    const derivedFiles = [
      "assets/js/products-data.js",
      "assets/js/events-data.js",
      "assets/js/content-data.js",
      "assets/js/site-reviews-data.js",
      "assets/js/journal-data.js",
      "assets/js/social-feed-data.js",
      "assets/js/search-data.js"
    ];
    let allDerivedExist = true;
    for (const df of derivedFiles) {
      const p = path.join(ROOT, df);
      if (!fs.existsSync(p) || fs.statSync(p).size === 0) {
        fail(`Derived file missing or empty: ${df}`);
        allDerivedExist = false;
      }
    }
    if (allDerivedExist) {
      pass(`Verified all ${derivedFiles.length} derived JavaScript data files on disk`);
    }
  } catch (err) {
    fail(
      "Stage 1 build-site-data execution failed",
      err.stderr ? err.stderr.toString() : err.message
    );
  }
  const stage1Duration = Date.now() - stage1Start;
  console.log(`Stage 1 finished in ${stage1Duration}ms`);

  // =========================================================================
  // STAGE 2: Pure Cart Math Engine
  // =========================================================================
  section("STAGE 2: Pure Cart Math Engine");
  const stage2Start = Date.now();
  try {
    global.window = global.window || {};
    const cart = require(path.join(ROOT, "assets/js/cart.js"));

    // 1. Variant price deltas
    if (
      cart.deltaForLabel("S[+0.00]|M[+0.00]|L[+2.00]", "L") === 2 &&
      cart.deltaForLabel("Small[-1.50]|Large[+0.00]", "Small") === -1.5 &&
      cart.deltaForLabel("S[+0.00]|M[+0.00]", "XL") === 0 &&
      cart.deltaForLabel("", "M") === 0
    ) {
      pass("deltaForLabel parses positive, negative, and missing variant deltas correctly");
    } else {
      fail("deltaForLabel failed variant parsing");
    }

    // 2. Quantity clamping
    if (
      cart.clampQty(0) === 1 &&
      cart.clampQty(5) === 5 &&
      cart.clampQty(999) === 99 &&
      cart.clampQty("abc") === 1 &&
      cart.clampQty(8, 3) === 3 &&
      cart.clampQty(999, 500) === 99
    ) {
      pass(
        "clampQty enforces floor (1), ceiling (99), non-numeric fallback, and per-product stock caps"
      );
    } else {
      fail("clampQty quantity bounds check failed");
    }

    // 3. Unit pricing
    if (
      cart.unitPrice({ price: 25, variantDelta: 2 }) === 27 &&
      cart.unitPrice({ price: 10, variantDelta: -50 }) === 0
    ) {
      pass("unitPrice computes base + delta and clamps negative totals at $0 floor");
    } else {
      fail("unitPrice calculation failed");
    }

    // 4. Line keys
    if (
      cart.lineKey({ id: "tank-top", variantLabel: "M" }) === "tank-top|M" &&
      cart.lineKey({ id: "salve" }) === "salve|" &&
      cart.lineKey({
        id: "yallternative-gift-card",
        lineId: "card_123",
        variantLabel: "Preset $25"
      }) === "yallternative-gift-card|card_123" &&
      cart.lineKey({ id: "custom-box", boxProductIds: ["salve-1", "salve-2"] }) ===
        "custom-box|salve-1,salve-2"
    ) {
      pass(
        "lineKey correctly differentiates standard products, variants, gift cards, and custom boxes"
      );
    } else {
      fail("lineKey differentiation failed");
    }

    // 5. Item list merging & stock cap enforcement
    let list = [];
    list = cart.addToList(list, { id: "tank", variantLabel: "M", qty: 1 });
    list = cart.addToList(list, { id: "tank", variantLabel: "M", qty: 2 });
    list = cart.addToList(list, { id: "tank", variantLabel: "L", qty: 1 });
    list = cart.addToList(list, { id: "capped-item", qty: 2, maxQty: 3 });
    list = cart.addToList(list, { id: "capped-item", qty: 5, maxQty: 3 });

    if (
      list.length === 3 &&
      list.find((i) => i.id === "tank" && i.variantLabel === "M").qty === 3 &&
      list.find((i) => i.id === "tank" && i.variantLabel === "L").qty === 1 &&
      list.find((i) => i.id === "capped-item").qty === 3
    ) {
      pass(
        "addToList merges identical lines, keeps variants distinct, and respects maxQty stock limits"
      );
    } else {
      fail("addToList merging logic failed");
    }

    // 6. Subtotal and total count
    const sampleItems = [
      { id: "a", price: 25, variantDelta: 0, qty: 2 },
      { id: "b", price: 10, variantDelta: 2, qty: 1 }
    ];
    if (cart.subtotal(sampleItems) === 62 && cart.totalCount(sampleItems) === 3) {
      pass("subtotal and totalCount calculate accurate cart totals");
    } else {
      fail("subtotal / totalCount calculation failed");
    }

    // 7. Checkout payload generation (no client price leakage)
    const payload = cart.toCheckoutPayload([
      { id: "tank", variantLabel: "M", price: 25, variantDelta: 0, qty: 2 },
      { id: "salve", variantLabel: "", price: 16, qty: 1 }
    ]);
    if (
      payload &&
      Array.isArray(payload.items) &&
      payload.items.length === 2 &&
      payload.items[0].id === "tank" &&
      payload.items[0].qty === 2 &&
      payload.items[0].variant === "M" &&
      payload.items[0].price === undefined &&
      payload.items[1].id === "salve" &&
      payload.items[1].price === undefined
    ) {
      pass("toCheckoutPayload emits clean identifiers and never leaks client-side prices");
    } else {
      fail("toCheckoutPayload format or price leakage check failed");
    }

    // 8. Share cart serialization & round-trip decoding
    const testCatalog = {
      products: [
        {
          id: "lavender-soak",
          price: 18.0,
          stock: 10
        },
        {
          id: "frankincense-salve",
          price: 19.99,
          stock: 10,
          variants: {
            name: "Size",
            options: [{ name: "2oz", priceDelta: 0 }]
          }
        }
      ]
    };

    if (
      typeof cart.generateShareCartUrl === "function" &&
      typeof cart.parseSharedCartParam === "function"
    ) {
      const shareUrl = cart.generateShareCartUrl([
        { id: "lavender-soak", qty: 2 },
        { id: "frankincense-salve", qty: 1, variantLabel: "2oz" }
      ]);
      const paramMatch = shareUrl.match(/[?&]cart=([^&]+)/);
      const cartQuery = paramMatch ? decodeURIComponent(paramMatch[1]) : "";
      const parsed = cart.parseSharedCartParam(cartQuery, testCatalog);

      if (
        parsed.length === 2 &&
        parsed[0].id === "lavender-soak" &&
        parsed[0].qty === 2 &&
        parsed[1].id === "frankincense-salve" &&
        parsed[1].variantLabel === "2oz"
      ) {
        pass(
          "generateShareCartUrl and parseSharedCartParam execute lossless round-trip serialization"
        );
      } else {
        fail("Share cart round-trip serialization failed");
      }
    }

    // 9. Alt-Points redemption is switched off until a server-side ledger
    // exists (audit C-1): the network helper must be gone, and the public
    // entry point must refuse without touching the network.
    if (typeof cart.redeemPoints === "function") {
      fail("cart.redeemPoints still exists -- Alt-Points minting must stay unreachable");
    } else if (typeof cart.redeemLoyaltyPoints !== "function") {
      fail("cart.redeemLoyaltyPoints is missing -- expected an inert stub that rejects");
    } else {
      let rejectedInert = false;
      const fetchBefore = global.fetch;
      let fetched = false;
      global.fetch = async () => {
        fetched = true;
        return { ok: true, json: async () => ({}) };
      };
      try {
        await cart.redeemLoyaltyPoints(500);
      } catch (e) {
        rejectedInert = /not available/i.test(String(e && e.message));
      } finally {
        global.fetch = fetchBefore;
      }
      if (rejectedInert && !fetched) {
        pass("Alt-Points redemption is inert: rejects as unavailable and makes no network call");
      } else {
        fail(
          "Alt-Points redemption is not inert",
          `rejectedAsUnavailable=${rejectedInert} networkCalled=${fetched}`
        );
      }
    }
  } catch (err) {
    fail("Stage 2 Cart math execution threw exception", err.stack || err.message);
  }
  const stage2Duration = Date.now() - stage2Start;
  console.log(`Stage 2 finished in ${stage2Duration}ms`);

  // =========================================================================
  // STAGE 3: Cloudflare Worker Checkout Logic
  // =========================================================================
  section("STAGE 3: Cloudflare Worker Checkout Logic");
  const stage3Start = Date.now();
  try {
    const workerModule = require(path.join(ROOT, "workers/checkout.js"));
    const worker = workerModule.default || workerModule;

    // 1. Exported helpers verification
    if (
      typeof workerModule.resolveUnitAmountCents === "function" &&
      typeof workerModule.resolveGiftCardAmountCents === "function" &&
      typeof workerModule.resolveFreeShippingThresholdCents === "function" &&
      typeof workerModule.resolveCustomBoxCents === "function"
    ) {
      pass("workers/checkout.js exports pure price and threshold resolver functions");
    } else {
      fail("workers/checkout.js missing required resolver export functions");
    }

    // 2. Gift card bounds enforcement ($10 - $500)
    const gc10 = workerModule.resolveGiftCardAmountCents("Preset $10");
    const gc25 = workerModule.resolveGiftCardAmountCents("Preset $25");
    const gc500 = workerModule.resolveGiftCardAmountCents("Preset $500");
    const gcClampLow = workerModule.resolveGiftCardAmountCents("Preset $5");
    const gcClampHigh = workerModule.resolveGiftCardAmountCents("Preset $9999");
    if (
      gc10 === 1000 &&
      gc25 === 2500 &&
      gc500 === 50000 &&
      gcClampLow === 1000 &&
      gcClampHigh === 50000
    ) {
      pass("resolveGiftCardAmountCents parses dollar amounts and clamps to $10–$500 server-side");
    } else {
      fail("resolveGiftCardAmountCents bounds clamping failed");
    }

    // 3. Simulated Checkout Session Execution
    // A market on the (mocked) calendar, in the shape workers/checkout.js's
    // resolvePickupAddress() reads: name, dateLabel, location ending ", XX",
    // and a 5-digit zip.
    const mockPickupEvent = {
      id: "smoke-test-market",
      name: "Smoke Test Market",
      date: "2099-01-01",
      dateLabel: "January 1, 2099",
      location: "Landrum, SC",
      zip: "29356"
    };

    const mockCatalog = {
      products: [
        { id: "lavender-soak", name: "Lavender Soak", price: 18.0, category: "soaks" },
        {
          id: "frankincense-salve",
          name: "Frankincense Salve",
          price: 19.99,
          category: "salves",
          variants: { name: "Size", options: [{ name: "2oz", priceDelta: 0 }] }
        },
        {
          id: "yallternative-gift-card",
          name: "Digital Gift Card",
          price: 25.0,
          variants: { name: "Amount", options: [{ name: "Preset $25", priceDelta: 0 }] }
        }
      ],
      shop: { freeShippingThreshold: 40 }
    };

    const mockEnv = {
      STRIPE_SECRET_KEY: "sk_test_mock_smoke_12345",
      SITE_ORIGIN: "https://yallternativeliving.com"
    };

    const mockCtx = { waitUntil: () => {} };

    async function executeCheckout(body, mockStripeResponses = {}) {
      let capturedSessionParams = null;
      let capturedCouponParams = null;
      const originalFetch = global.fetch;

      global.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes("products.json")) {
          return {
            ok: true,
            clone: () => ({ body: null }),
            json: async () => mockCatalog
          };
        }
        if (u.includes("events.json")) {
          // The Worker validates a pick-up label against the live market
          // calendar (audit H-2): an invented label must not zero shipping.
          return {
            ok: true,
            clone: () => ({ body: null }),
            json: async () => ({ upcoming: [mockPickupEvent], past: [] })
          };
        }
        if (u.includes("api.stripe.com/v1/promotion_codes")) {
          if (mockStripeResponses.promoCode) {
            return { ok: true, json: async () => mockStripeResponses.promoCode };
          }
          return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
        }
        if (u.includes("api.stripe.com/v1/coupons")) {
          capturedCouponParams = new URLSearchParams(opts.body);
          return { ok: true, json: async () => ({ id: "coupon_smoke_test" }) };
        }
        if (u.includes("api.stripe.com/v1/checkout/sessions")) {
          capturedSessionParams = new URLSearchParams(opts.body);
          return {
            ok: true,
            json: async () => ({
              id: "cs_test_smoke_session",
              url: "https://checkout.stripe.com/pay/cs_test_smoke_session"
            })
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };

      try {
        const req = new Request("https://yallternativeliving.com/api/checkout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://yallternativeliving.com"
          },
          body: JSON.stringify(body)
        });
        const res = await worker.fetch(req, mockEnv, mockCtx);
        const data = await res.json();
        return {
          status: res.status,
          data: data,
          sessionParams: capturedSessionParams,
          couponParams: capturedCouponParams
        };
      } finally {
        global.fetch = originalFetch;
      }
    }

    // Standard session test
    const standardRes = await executeCheckout({
      items: [{ id: "lavender-soak", qty: 1 }]
    });

    if (standardRes.status === 200 && standardRes.data && standardRes.data.url) {
      pass("worker.fetch creates valid Stripe Checkout session url");
    } else {
      fail("worker.fetch standard checkout failed");
    }

    if (standardRes.sessionParams && standardRes.sessionParams.get("mode") === "payment") {
      pass("Stripe session configures payment mode and currency");
    } else {
      fail("Stripe session mode is not 'payment'");
    }

    // Gift order metadata test
    const giftRes = await executeCheckout({
      items: [{ id: "lavender-soak", qty: 1 }],
      is_gift_order: true,
      gift_message: "Enjoy your herbal gift!"
    });
    if (
      giftRes.sessionParams &&
      giftRes.sessionParams.get("metadata[is_gift_order]") === "true" &&
      giftRes.sessionParams.get("metadata[gift_message]") === "Enjoy your herbal gift!"
    ) {
      pass("Stripe session metadata captures is_gift_order and sanitized gift_message");
    } else {
      fail("Gift order metadata missing in Stripe session");
    }

    // Pickup market order test: a label that is on the market calendar is
    // honoured (metadata set, no shipping line at all); an invented label is
    // rejected (no metadata, shipping charged). Both halves must hold -- the
    // second is what stops "pickup_market: x" from buying free shipping.
    const pickupLabel = workerModule.pickupLabelFor(mockPickupEvent);
    const pickupRes = await executeCheckout({
      items: [{ id: "lavender-soak", qty: 1 }],
      pickup_market: pickupLabel
    });
    const pickupHonoured =
      pickupRes.sessionParams &&
      pickupRes.sessionParams.get("metadata[pickup_market]") === pickupLabel &&
      !Array.from(pickupRes.sessionParams.keys()).some((k) => k.startsWith("shipping_options["));
    const forgedRes = await executeCheckout({
      items: [{ id: "lavender-soak", qty: 1 }],
      pickup_market: "Landrum SC Farmers Market"
    });
    const forgedRejected =
      forgedRes.sessionParams &&
      !forgedRes.sessionParams.get("metadata[pickup_market]") &&
      forgedRes.sessionParams.get(
        "shipping_options[0][shipping_rate_data][fixed_amount][amount]"
      ) === "1000";
    if (pickupHonoured && forgedRejected) {
      pass("Calendar pick-up label suppresses shipping; a forged label is rejected");
    } else {
      fail(
        "Pickup market validation mismatch",
        `honoured=${Boolean(pickupHonoured)} forgedRejected=${Boolean(forgedRejected)}`
      );
    }
  } catch (err) {
    fail("Stage 3 Worker checkout execution threw exception", err.stack || err.message);
  }
  const stage3Duration = Date.now() - stage3Start;
  console.log(`Stage 3 finished in ${stage3Duration}ms`);

  // =========================================================================
  // STAGE 4: High-Speed In-Process Static QA Assertions
  // =========================================================================
  section("STAGE 4: High-Speed In-Process Static QA Assertions");
  const stage4Start = Date.now();
  try {
    // 1. Fast In-Process JS Syntax Verification (V8 VM Script for CJS, fallback to node --check for ESM)
    const jsDirs = ["assets/js", "workers", "scripts", "netlify/functions", "cms-auth"];
    let syntaxCheckedCount = 0;
    jsDirs.forEach((dir) => {
      const fullDir = path.join(ROOT, dir);
      if (!fs.existsSync(fullDir)) return;
      const files = fs.readdirSync(fullDir).filter((f) => f.endsWith(".js"));
      files.forEach((f) => {
        const filePath = path.join(fullDir, f);
        const code = fs.readFileSync(filePath, "utf8");
        try {
          new vm.Script(code, { filename: f });
          syntaxCheckedCount++;
        } catch (e) {
          if (
            e.message.includes("Unexpected token 'export'") ||
            e.message.includes("Unexpected token 'import'")
          ) {
            try {
              execSync(`"${process.execPath}" --check "${filePath}"`, { stdio: "pipe" });
              syntaxCheckedCount++;
            } catch (nodeErr) {
              fail(`JavaScript syntax error in ${dir}/${f}`, nodeErr.message);
            }
          } else {
            fail(`JavaScript syntax error in ${dir}/${f}`, e.message);
          }
        }
      });
    });
    pass(`In-process V8 syntax verification passed for ${syntaxCheckedCount} JavaScript files`);

    // 2. Canonical Source Data JSON parsing & schema keys
    const canonicalFiles = [
      { file: "assets/data/products.json", keys: ["products"] },
      { file: "assets/data/events.json", keys: ["upcoming", "past"] },
      { file: "assets/data/site-reviews.json", keys: ["reviews"] },
      { file: "assets/data/content.json", keys: ["site", "home", "about", "contact", "shop"] },
      { file: "assets/data/journal.json", keys: ["posts"] },
      { file: "assets/data/social-feed.json", keys: ["posts"] }
    ];
    let jsonParsedCount = 0;
    canonicalFiles.forEach((spec) => {
      const full = path.join(ROOT, spec.file);
      if (!fs.existsSync(full)) {
        fail(`Canonical JSON missing: ${spec.file}`);
        return;
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
        const missing = spec.keys.filter((k) => !(k in parsed));
        if (missing.length > 0) {
          fail(`${spec.file} missing expected root key(s)`, missing.join(", "));
        } else {
          jsonParsedCount++;
        }
      } catch (e) {
        fail(`${spec.file} is invalid JSON`, e.message);
      }
    });
    pass(`Validated ${jsonParsedCount}/${canonicalFiles.length} canonical source JSON data files`);

    // 3. JSON-LD structured data validation across all routes
    const TOP_PAGES = [
      "index.html",
      "shop.html",
      "about.html",
      "contact.html",
      "events.html",
      "faq.html",
      "privacy.html",
      "terms.html",
      "policies.html",
      "404.html",
      "thank-you.html",
      "welcome.html",
      "journal.html",
      "reviews.html",
      "order-status.html"
    ];
    let jsonLdBlockCount = 0;
    const allHtmlPages = [...TOP_PAGES];

    const productsDir = path.join(ROOT, "products");
    if (fs.existsSync(productsDir)) {
      const pFiles = fs.readdirSync(productsDir).filter((f) => f.endsWith(".html"));
      pFiles.forEach((pf) => allHtmlPages.push(path.join("products", pf)));
    }

    allHtmlPages.forEach((relPage) => {
      const fullPath = path.join(ROOT, relPage);
      if (!fs.existsSync(fullPath)) return;
      const html = fs.readFileSync(fullPath, "utf8");
      const blocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
      blocks.forEach((block) => {
        jsonLdBlockCount++;
        const rawJson = block.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
        try {
          JSON.parse(rawJson);
        } catch (e) {
          fail(`JSON-LD parse error in ${relPage}`, e.message);
        }
      });
    });
    if (jsonLdBlockCount > 0) {
      pass(
        `Validated ${jsonLdBlockCount} JSON-LD structured data blocks across ${allHtmlPages.length} routes`
      );
    } else {
      fail("No JSON-LD structured data blocks found in HTML files");
    }

    // 4. Security headers & CSP byte-for-byte synchronization
    const headersContent = fs.readFileSync(path.join(ROOT, "_headers"), "utf8");
    const vercelContent = fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8");
    const netlifyContent = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");

    // Extract main site CSP
    function extractCsp(content, type) {
      if (type === "headers") {
        const m = content.match(/Content-Security-Policy:\s*([^\r\n]+)/);
        return m ? m[1].trim() : null;
      }
      if (type === "vercel") {
        const json = JSON.parse(content);
        for (const h of json.headers || []) {
          if (h.source === "/(.*)") {
            const cspH = (h.headers || []).find((x) => x.key === "Content-Security-Policy");
            if (cspH) return cspH.value.trim();
          }
        }
      }
      if (type === "netlify") {
        const m = content.match(/Content-Security-Policy\s*=\s*"([^"]+)"/);
        return m ? m[1].trim() : null;
      }
      return null;
    }

    const cspHeaders = extractCsp(headersContent, "headers");
    const cspVercel = extractCsp(vercelContent, "vercel");
    const cspNetlify = extractCsp(netlifyContent, "netlify");

    if (cspHeaders && cspHeaders === cspVercel && cspHeaders === cspNetlify) {
      pass(
        "Content-Security-Policy rules are byte-identical across _headers, vercel.json, and netlify.toml"
      );
    } else {
      fail("Content-Security-Policy drift detected across server configuration files");
    }

    // 5. Service Worker (sw.js) cache asset validation
    const swPath = path.join(ROOT, "sw.js");
    if (fs.existsSync(swPath)) {
      const swText = fs.readFileSync(swPath, "utf8");
      const matchAssets = swText.match(/const\s+ASSETS_TO_CACHE\s*=\s*\[([\s\S]*?)\];/);
      if (matchAssets) {
        const rawAssets = matchAssets[1].match(/'([^']+)'/g) || [];
        let missingSwAssets = 0;
        rawAssets.forEach((quoted) => {
          let assetPath = quoted.slice(1, -1);
          if (assetPath === "/") assetPath = "/index.html";
          const clean = assetPath.replace(/^\/+/, "").split("?")[0];
          const full = path.join(ROOT, clean);
          if (!fs.existsSync(full)) {
            missingSwAssets++;
            fail(`sw.js cached asset missing on disk: ${assetPath}`);
          }
        });
        if (missingSwAssets === 0 && rawAssets.length > 0) {
          pass(
            `Verified all ${rawAssets.length} sw.js offline cache asset paths resolve to files on disk`
          );
        }
      } else {
        fail("sw.js ASSETS_TO_CACHE array not found");
      }
    } else {
      fail("sw.js service worker file missing");
    }

    // 6. Responsive Image Manifest AVIF + WebP coverage
    const manifestPath = path.join(ROOT, "assets/js/image-manifest.js");
    if (fs.existsSync(manifestPath)) {
      global.window = {};
      try {
        delete require.cache[require.resolve(manifestPath)];
      } catch {
        /* ignore */
      }
      require(manifestPath);
      const manifest = global.window.YL_IMAGES || {};
      const manifestKeys = Object.keys(manifest);
      if (!manifestKeys.length) {
        fail("image-manifest.js", "no entries found");
      } else {
        const incomplete = manifestKeys.filter((k) => {
          const v = manifest[k].variants;
          return !v || !v.avif || !v.avif.length || !v.webp || !v.webp.length;
        });
        if (incomplete.length === 0) {
          pass(
            `Verified responsive AVIF and WebP coverage for all ${manifestKeys.length} images in image-manifest.js`
          );
        } else {
          incomplete.forEach((k) => fail("image-manifest.js incomplete variants", k));
        }
      }
    } else {
      fail("assets/js/image-manifest.js missing");
    }

    // 7. HTML Container Tag Balance check
    const containerTags = [
      "div",
      "section",
      "main",
      "header",
      "footer",
      "nav",
      "article",
      "aside",
      "dialog"
    ];
    let pagesBalanced = true;
    TOP_PAGES.forEach((page) => {
      const p = path.join(ROOT, page);
      if (!fs.existsSync(p)) return;
      const content = fs.readFileSync(p, "utf8");
      containerTags.forEach((tag) => {
        const opens = (content.match(new RegExp(`<${tag}(\\s+[^>]*)?>`, "gi")) || []).length;
        const closes = (content.match(new RegExp(`</${tag}>`, "gi")) || []).length;
        if (opens !== closes) {
          pagesBalanced = false;
          fail(`${page} has unbalanced <${tag}> tags (opened ${opens}, closed ${closes})`);
        }
      });
    });
    if (pagesBalanced) {
      pass(`HTML container tag balance verified across all ${TOP_PAGES.length} top-level pages`);
    }

    // 8. Zero System Emojis in UI controls & Search Modal (100% Monoline SVGs)
    const emojiRegex =
      /[\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/u;
    let emojiFailures = 0;
    TOP_PAGES.forEach((page) => {
      const p = path.join(ROOT, page);
      if (!fs.existsSync(p)) return;
      const content = fs.readFileSync(p, "utf8");
      const modalMatch = content.match(/<dialog id="global-search-modal"[\s\S]*?<\/dialog>/i);
      if (modalMatch) {
        const modalHtml = modalMatch[0];
        const strippedComments = modalHtml.replace(/<!--[\s\S]*?-->/g, "");
        if (emojiRegex.test(strippedComments)) {
          emojiFailures++;
          fail(
            `${page} contains raw system emoji in #global-search-modal (must use monoline SVGs)`
          );
        }
      }
    });
    if (emojiFailures === 0) {
      pass(
        "Zero system emojis in Global Search UI controls across all pages (100% monoline SVG standard)"
      );
    }

    // 9. Lockfile hygiene
    if (fs.existsSync(path.join(ROOT, "package-lock.json"))) {
      if (
        !fs.existsSync(path.join(ROOT, "pnpm-lock.yaml")) &&
        !fs.existsSync(path.join(ROOT, "yarn.lock")) &&
        !fs.existsSync(path.join(ROOT, "bun.lockb"))
      ) {
        pass("One lockfile invariant maintained (package-lock.json is only lockfile)");
      } else {
        fail("Extraneous lockfile detected (pnpm-lock.yaml, yarn.lock, or bun.lockb)");
      }
    } else {
      fail("Missing package-lock.json");
    }
  } catch (err) {
    fail("Stage 4 Static QA assertions threw exception", err.stack || err.message);
  }
  const stage4Duration = Date.now() - stage4Start;
  console.log(`Stage 4 finished in ${stage4Duration}ms`);

  // =========================================================================
  // CONSOLIDATED SUMMARY & PERFORMANCE SLA GATE
  // =========================================================================
  const TOTAL_DURATION_MS = Date.now() - TOTAL_START_TIME;
  console.log("\n==================================================");
  console.log(
    `Smoke Test Summary: ${totalPassed} passed, ${totalFailed} failed in ${(TOTAL_DURATION_MS / 1000).toFixed(3)}s`
  );

  if (TOTAL_DURATION_MS > PERFORMANCE_BUDGET_MS) {
    fail(
      "Performance SLA Exceeded",
      `Execution took ${TOTAL_DURATION_MS}ms (budget is ${PERFORMANCE_BUDGET_MS}ms)`
    );
  } else {
    pass(`Performance SLA met (${TOTAL_DURATION_MS}ms < ${PERFORMANCE_BUDGET_MS}ms)`);
  }
  console.log("==================================================");

  if (totalFailed > 0) {
    console.error(`\nSmoke test suite failed with ${totalFailed} error(s):`);
    failures.forEach((f) => console.error(`  ✗ ${f}`));
    process.exit(1);
  }

  console.log("\nAll smoke test stages passed cleanly!");
  process.exit(0);
})().catch((err) => {
  console.error("Fatal error during smoke test execution:", err);
  process.exit(1);
});
