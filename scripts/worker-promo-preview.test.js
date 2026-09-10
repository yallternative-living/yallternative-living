/**
 * @fileoverview POST /api/promo-preview (workers/routes/promo-preview.js) and
 * the way checkout.js attaches a validated promo code to the session.
 *
 *   1. the preview: valid percent, valid amount, minimum not met, expired /
 *      inactive / exhausted, unknown, malformed, a gift-card string, the
 *      limiter, the CMS switch, Stripe unreachable
 *   2. evaluatePromotion on its own (the verdict table)
 *   3. checkout: `discounts[0][promotion_code]` only when appropriate -- never
 *      with a gift card (one-or-the-other, said structurally), never when the
 *      code is dead, never with `allow_promotion_codes` alongside it
 *
 * Stripe is a mocked fetch, as in scripts/worker-checkout.test.js; the
 * limiter is the real RateLimitCounter over the in-memory Durable Object.
 *
 * Run: node scripts/worker-promo-preview.test.js
 */

const workerModule = require("../workers/checkout.js");
const worker = workerModule.default || workerModule;
const promo = require("../workers/routes/promo-preview.js");
const { makeNamespace } = require("./lib/d1-emulator.js");
const { executeCheckout, mockPromo, mockCatalog } = require("./worker-checkout.test.js");

let passed = 0;
let failed = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else {
    failed++;
    console.error(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
  }
}

function assert(condition, label) {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const ORIGIN = "https://yallternativeliving.com";
const CART = [{ id: "lavender-soak", qty: 1 }]; // $18.00 -> 1800 cents

/**
 * POST one preview through the real Worker router.
 *
 * @param {object} body
 * @param {object} options
 *   `promoCodes`   {CODE: promotion code object} Stripe knows (mockPromo)
 *   `bareCoupon`   answer the lookup with the coupon as a bare id, so the
 *                  Worker has to fetch /coupons/{id} itself
 *   `stripeDown`   every Stripe call fails
 *   `site`         the `site` object content.json serves (default: none)
 *   `env`          bindings merged over the defaults
 *   `headers`      extra request headers
 *   `rawBody`      send this string instead of JSON.stringify(body)
 */
async function executePreview(body, options = {}) {
  const calls = { promo: [], coupons: [] };
  const env = {
    STRIPE_SECRET_KEY: options.noKey ? undefined : "sk_test_mock_12345",
    SITE_ORIGIN: ORIGIN,
    ...(options.env || {})
  };
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("products.json")) {
      return { ok: true, clone: () => ({ body: null }), json: async () => mockCatalog };
    }
    if (u.includes("content.json")) {
      if (!options.site) return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        clone: () => ({ body: null }),
        json: async () => ({ site: options.site })
      };
    }
    if (u.includes("api.stripe.com/v1/promotion_codes")) {
      calls.promo.push(u);
      if (options.stripeDown) return { ok: false, status: 500, json: async () => ({}) };
      const wanted = new URL(u).searchParams.get("code");
      const known = options.promoCodes || {};
      const match = Object.keys(known).find((c) => c.toUpperCase() === String(wanted || ""));
      let rows = match ? [known[match]] : [];
      if (options.bareCoupon) {
        rows = rows.map((row) => {
          const { coupon, ...rest } = row;
          return { ...rest, promotion: { type: "coupon", coupon: coupon.id } };
        });
      }
      return { ok: true, status: 200, json: async () => ({ object: "list", data: rows }) };
    }
    if (u.includes("api.stripe.com/v1/coupons/")) {
      calls.coupons.push(u);
      const id = decodeURIComponent(u.split("/").pop());
      const known = options.promoCodes || {};
      const owner = Object.values(known).find((row) => (row.coupon || {}).id === id);
      const coupon = owner ? owner.coupon : (options.coupons || {})[id];
      if (!coupon) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => coupon };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const req = new Request(`${ORIGIN}/api/promo-preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        ...(options.headers || {})
      },
      body: options.rawBody !== undefined ? options.rawBody : JSON.stringify(body)
    });
    const res = await worker.fetch(req, env, { waitUntil() {} });
    return { status: res.status, data: await res.json(), calls };
  } finally {
    global.fetch = originalFetch;
  }
}

async function run() {
  console.log("Running promo-preview tests...");

  /* ---------------------------------------------------- 1. the preview */
  {
    const r = await executePreview(
      { code: "welcome10", items: CART },
      { promoCodes: { WELCOME10: mockPromo("WELCOME10", { percent: 10 }) } }
    );
    eq(r.status, 200, "valid percent code: HTTP 200");
    eq(
      r.data,
      {
        valid: true,
        code: "WELCOME10",
        kind: "percent",
        percentOff: 10,
        amountOffCents: null,
        minimumAmountCents: 0,
        restrictions: { firstTimeOnly: false },
        estimatedDiscountCents: 180,
        subtotalCents: 1800
      },
      "valid percent code: the full contract, estimated over checkout's own priced lines"
    );
    assert(
      !JSON.stringify(r.data).includes("promo_WELCOME10") &&
        !JSON.stringify(r.data).includes("coupon_WELCOME10"),
      "the promotion and coupon ids never reach the browser"
    );
    assert(
      r.calls.promo[0].includes("code=WELCOME10") && r.calls.promo[0].includes("active=true"),
      "Stripe is asked for the upper-cased code, active ones only"
    );
  }
  {
    const r = await executePreview(
      { code: "FIVEOFF", items: CART },
      {
        promoCodes: {
          FIVEOFF: mockPromo("FIVEOFF", { amountCents: 500, firstTimeOnly: true })
        }
      }
    );
    eq(r.data.valid, true, "valid amount code: valid");
    eq(r.data.kind, "amount", "valid amount code: kind");
    eq(r.data.amountOffCents, 500, "valid amount code: amountOffCents");
    eq(r.data.percentOff, null, "valid amount code: no percent");
    eq(r.data.estimatedDiscountCents, 500, "valid amount code: estimate");
    eq(
      r.data.restrictions,
      { firstTimeOnly: true },
      "valid amount code: the first-order restriction is reported, not enforced here"
    );
  }
  {
    // A $5-off code on a $3 line is worth $3, never a negative total.
    const r = await executePreview(
      { code: "FIVEOFF", items: [{ id: "frankincense-salve", qty: 1, variant: "1oz" }] },
      { promoCodes: { FIVEOFF: mockPromo("FIVEOFF", { amountCents: 5000 }) } }
    );
    eq(r.data.valid, true, "amount larger than the goods: still valid");
    eq(r.data.estimatedDiscountCents, 1399, "...capped at the goods subtotal");
  }
  {
    const r = await executePreview(
      { code: "BIG25", items: CART },
      { promoCodes: { BIG25: mockPromo("BIG25", { percent: 25, minimumCents: 5000 }) } }
    );
    eq(r.status, 200, "minimum not met: HTTP 200");
    eq(r.data.valid, false, "minimum not met: not valid");
    eq(r.data.reason, "minimum_not_met", "minimum not met: reason");
    eq(r.data.minimumAmountCents, 5000, "minimum not met: the minimum is reported");
    eq(
      r.data.error,
      "This code needs a subtotal of at least $50.",
      "minimum not met: curated copy"
    );
    const enough = await executePreview(
      { code: "BIG25", items: [{ id: "lavender-soak", qty: 3 }] },
      { promoCodes: { BIG25: mockPromo("BIG25", { percent: 25, minimumCents: 5000 }) } }
    );
    eq(enough.data.valid, true, "...and valid once the cart reaches it");
    eq(enough.data.estimatedDiscountCents, 1350, "...25% of $54");
    eq(enough.data.minimumAmountCents, 5000, "...with the minimum still reported");
  }
  {
    const r = await executePreview(
      { code: "OLD", items: CART },
      { promoCodes: { OLD: mockPromo("OLD", { percent: 10, active: false }) } }
    );
    eq(
      r.data,
      { valid: false, reason: "expired", error: promo.PROMO_COPY.expired },
      "inactive code"
    );
    const past = await executePreview(
      { code: "PAST", items: CART },
      { promoCodes: { PAST: mockPromo("PAST", { percent: 10, expiresAt: 1000 }) } }
    );
    eq(past.data.reason, "expired", "expired code");
    const used = await executePreview(
      { code: "USED", items: CART },
      {
        promoCodes: {
          USED: mockPromo("USED", { percent: 10, maxRedemptions: 1, timesRedeemed: 1 })
        }
      }
    );
    eq(used.data.reason, "expired", "a single-use code that was used");
    const dead = await executePreview(
      { code: "DEAD", items: CART },
      { promoCodes: { DEAD: mockPromo("DEAD", { percent: 10, couponValid: false }) } }
    );
    eq(dead.data.reason, "expired", "a code whose coupon is no longer valid");
  }
  {
    const r = await executePreview({ code: "NOPE", items: CART }, { promoCodes: {} });
    eq(r.status, 200, "unknown code: HTTP 200");
    eq(
      r.data,
      { valid: false, reason: "unknown", error: promo.PROMO_COPY.unknown },
      "unknown code"
    );
  }
  {
    for (const bad of ["", "   ", "A", "BAD CODE!", "x".repeat(41), 42, null, { code: 1 }]) {
      const r = await executePreview(
        { code: bad, items: CART },
        { promoCodes: { BADCODE: mockPromo("BADCODE", { percent: 10 }) } }
      );
      eq(r.status, 200, `malformed ${JSON.stringify(bad)}: HTTP 200`);
      eq(r.data.reason, "malformed", `malformed ${JSON.stringify(bad)}: reason`);
      eq(r.calls.promo.length, 0, `malformed ${JSON.stringify(bad)}: costs no Stripe lookup`);
    }
    const spaced = await executePreview(
      { code: " wel come10 ", items: CART },
      { promoCodes: { WELCOME10: mockPromo("WELCOME10", { percent: 10 }) } }
    );
    eq(spaced.data.valid, true, "pasted spacing is stripped before the lookup");
    const gc = await executePreview({ code: "YALL-AAAA-BBBB-CCCC", items: CART });
    eq(gc.data.reason, "gift_card", "a gift-card string is pointed at the gift card box");
    eq(gc.calls.promo.length, 0, "...without a Stripe lookup");
    const noJson = await executePreview(null, { rawBody: "{not json" });
    eq(noJson.status, 400, "a body that is not JSON is a 400");
    eq(noJson.data.error, "Please enter a promo code.", "...with shopper-safe copy");
  }
  {
    // An unsellable cart is refused with checkout's own sentence.
    const r = await executePreview(
      { code: "WELCOME10", items: [{ id: "sold-out-soak", qty: 1 }] },
      { promoCodes: { WELCOME10: mockPromo("WELCOME10", { percent: 10 }) } }
    );
    eq(r.data.reason, "cart_invalid", "a cart checkout would refuse: cart_invalid");
    eq(r.data.error, "Sold out: Sold Out Soak", "...with checkout's own sentence");
    const empty = await executePreview(
      { code: "WELCOME10", items: [] },
      { promoCodes: { WELCOME10: mockPromo("WELCOME10", { percent: 10 }) } }
    );
    eq(empty.data.reason, "cart_invalid", "an empty cart has nothing to discount");
  }
  {
    // Coupon as a bare id (the nested `promotion.coupon` shape): fetched.
    const r = await executePreview(
      { code: "NESTED", items: CART },
      { promoCodes: { NESTED: mockPromo("NESTED", { percent: 15 }) }, bareCoupon: true }
    );
    eq(r.data.valid, true, "a promotion code carrying its coupon as an id is resolved");
    eq(r.data.estimatedDiscountCents, 270, "...to the right coupon");
    eq(r.calls.coupons.length, 1, "...with one coupon fetch");
  }
  {
    const r = await executePreview(
      { code: "WELCOME10", items: CART },
      { promoCodes: { WELCOME10: mockPromo("WELCOME10", { percent: 10 }) }, stripeDown: true }
    );
    eq(r.status, 200, "Stripe unreachable: HTTP 200");
    eq(r.data.reason, "unavailable", "Stripe unreachable: unavailable, never 'not valid'");
    const noKey = await executePreview({ code: "WELCOME10", items: CART }, { noKey: true });
    eq(noKey.data.reason, "unavailable", "no STRIPE_SECRET_KEY: unavailable");
    eq(noKey.calls.promo.length, 0, "...without a lookup");
  }
  {
    // The CMS switch.
    const off = await executePreview(
      { code: "WELCOME10", items: CART },
      {
        promoCodes: { WELCOME10: mockPromo("WELCOME10", { percent: 10 }) },
        site: { enablePromoCodes: false }
      }
    );
    eq(off.status, 200, "site.enablePromoCodes false: HTTP 200");
    eq(off.data.reason, "disabled", "site.enablePromoCodes false: disabled");
    eq(off.calls.promo.length, 0, "...and Stripe is not asked");
    const on = await executePreview(
      { code: "WELCOME10", items: CART },
      {
        promoCodes: { WELCOME10: mockPromo("WELCOME10", { percent: 10 }) },
        site: { enablePromoCodes: true }
      }
    );
    eq(on.data.valid, true, "site.enablePromoCodes true: works");
    const unset = await executePreview(
      { code: "WELCOME10", items: CART },
      { promoCodes: { WELCOME10: mockPromo("WELCOME10", { percent: 10 }) }, site: {} }
    );
    eq(unset.data.valid, true, "site.enablePromoCodes absent: on by default");
  }
  {
    // The limiter: 5 a minute per client, then 429, fail-open without a backend.
    const { RateLimitCounter } = await import("../workers/state/rate-limit.js");
    const limiterEnv = { RATE_LIMIT_COUNTER: makeNamespace(RateLimitCounter) };
    const ip = "203.0.113.5";
    const opts = {
      promoCodes: { WELCOME10: mockPromo("WELCOME10", { percent: 10 }) },
      env: limiterEnv,
      headers: { "X-Forwarded-For": ip }
    };
    let last = null;
    for (let i = 0; i < promo.PROMO_PREVIEW_RATE_LIMIT.limit; i++) {
      last = await executePreview({ code: "WELCOME10", items: CART }, opts);
    }
    eq(last.status, 200, "lookups up to the limit succeed");
    const over = await executePreview({ code: "WELCOME10", items: CART }, opts);
    eq(over.status, 429, "one more in the same minute is rate limited");
    eq(over.data.reason, "rate_limited", "...with the reason named");
    eq(over.data.error, promo.PROMO_COPY.rate_limited, "...and shopper-safe copy");
    eq(over.calls.promo.length, 0, "...and never reaches Stripe");
    const malformed = await executePreview({ code: "!", items: CART }, opts);
    eq(malformed.data.reason, "malformed", "a malformed guess is answered even when throttled");
    const other = await executePreview(
      { code: "WELCOME10", items: CART },
      { ...opts, headers: { "X-Forwarded-For": "198.51.100.7" } }
    );
    eq(other.status, 200, "another client is not affected");
    const open = await executePreview(
      { code: "WELCOME10", items: CART },
      { ...opts, env: {}, headers: { "X-Forwarded-For": ip } }
    );
    eq(open.status, 200, "with no limiter backend the preview fails open");
  }

  /* --------------------------------------- 2. evaluatePromotion itself */
  {
    const now = 1_800_000_000_000;
    const percent = mockPromo("P", { percent: 33 });
    eq(promo.evaluatePromotion(percent, 1001, now).estimatedDiscountCents, 330, "33% of $10.01");
    eq(promo.evaluatePromotion(percent, 0, now).estimatedDiscountCents, 0, "33% of nothing");
    eq(
      promo.evaluatePromotion(mockPromo("P", { percent: 150 }), 1000, now).estimatedDiscountCents,
      1000,
      "a percent over 100 is capped at the goods"
    );
    eq(
      promo.evaluatePromotion(mockPromo("E", { amountCents: 500, currency: "eur" }), 1000, now)
        .reason,
      "not_applicable",
      "an amount-off coupon in another currency"
    );
    const limited = mockPromo("L", { percent: 10 });
    limited.coupon.applies_to = { products: ["prod_123"] };
    eq(
      promo.evaluatePromotion(limited, 1000, now).reason,
      "not_applicable",
      "a coupon limited to specific Stripe products (line items here are ad-hoc prices)"
    );
    const nothing = mockPromo("N", {});
    eq(promo.evaluatePromotion(nothing, 1000, now).reason, "not_applicable", "no discount at all");
    eq(
      promo.evaluatePromotion(mockPromo("R", { percent: 10 }), 1000, now).valid,
      true,
      "plain 10% is valid"
    );
    const byDate = mockPromo("D", { percent: 10 });
    byDate.coupon.redeem_by = Math.floor(now / 1000) - 60;
    eq(promo.evaluatePromotion(byDate, 1000, now).reason, "expired", "coupon redeem_by passed");
    eq(promo.evaluatePromotion(null, 1000, now).reason, "expired", "nothing at all is expired");
    eq(promo.evaluatePromotion({ ...percent, coupon: null }, 1000, now).valid, false, "no coupon");
  }
  {
    eq(promo.normalizePromoCode(" yall-10 "), "YALL-10", "normalize: trims, upper-cases");
    eq(promo.normalizePromoCode("A"), "", "normalize: one character is not a code");
    eq(promo.normalizePromoCode("-AB"), "", "normalize: cannot start with a dash");
    eq(promo.normalizePromoCode("AB_C"), "", "normalize: underscores are refused");
    eq(promo.normalizePromoCode("A".repeat(40)), "A".repeat(40), "normalize: 40 is allowed");
    eq(promo.normalizePromoCode("A".repeat(41)), "", "normalize: 41 is not");
    eq(
      promo.copyFor("minimum_not_met", { amount: "$50" }),
      promo.PROMO_COPY.minimum_not_met.replace("{amount}", "$50"),
      "copyFor fills the amount"
    );
    eq(promo.copyFor("nonsense"), promo.PROMO_COPY.unknown, "copyFor falls back to 'unknown'");
  }

  /* ----------------------------------------------------- 3. checkout */
  const codes = { WELCOME10: mockPromo("WELCOME10", { percent: 10 }) };
  {
    const r = await executeCheckout(
      { items: CART, discount_code: "welcome10" },
      { promoCodes: codes }
    );
    eq(r.status, 200, "checkout with a live code: HTTP 200");
    eq(
      r.sessionParams.get("discounts[0][promotion_code]"),
      "promo_WELCOME10",
      "...attaches the promotion code id as the session's one discount"
    );
    eq(r.sessionParams.get("discounts[0][coupon]"), null, "...and no coupon");
    eq(r.sessionParams.get("allow_promotion_codes"), null, "...and no code box on Stripe's page");
    eq(
      r.sessionParams.get("after_expiration[recovery][allow_promotion_codes]"),
      "true",
      "...the recovery session still takes a code (it never carries this one)"
    );
    eq(r.sessionParams.get("metadata[discount_code]"), "WELCOME10", "...metadata keeps the code");
    eq(
      r.data.promo,
      { code: "WELCOME10", applied: true, estimatedDiscountCents: 180 },
      "...and the answer says so"
    );
    eq(r.promoLookups.length, 1, "...after exactly one server-side lookup");
  }
  {
    // ONE discount: a gift card holds the slot, the code is not attached.
    const r = await executeCheckout(
      { items: CART, discount_code: "WELCOME10", gift_card_code: "YALL-AAAA-BBBB-CCCC" },
      { promoCodes: codes, cards: { "YALL-AAAA-BBBB-CCCC": 500 } }
    );
    // The drawer never sends both; a client that does is told which to drop
    // rather than sent to a full-price page with the code silently dropped.
    eq(r.status, 400, "gift card + code: refused, not silently checked out without the code");
    eq(r.sessionParams, null, "...no session was created");
    eq(
      r.data.promo,
      { code: "WELCOME10", applied: false, reason: "gift_card_conflict" },
      "...and the answer explains one-or-the-other structurally"
    );
    eq(r.promoLookups.length, 0, "...without asking Stripe for the code");
  }
  {
    const r = await executeCheckout({ items: CART, discount_code: "NOPE" }, { promoCodes: codes });
    eq(r.status, 400, "a dead code refuses the checkout");
    eq(r.data.error, promo.PROMO_COPY.unknown, "...with curated copy");
    eq(r.data.promo, { code: "NOPE", applied: false, reason: "unknown" }, "...and the reason");
    eq(r.sessionParams, null, "...before any session exists");
    const min = await executeCheckout(
      { items: CART, discount_code: "BIG25" },
      { promoCodes: { BIG25: mockPromo("BIG25", { percent: 25, minimumCents: 5000 }) } }
    );
    eq(min.status, 400, "a code under its minimum refuses the checkout");
    eq(
      min.data.promo,
      { code: "BIG25", applied: false, reason: "minimum_not_met", minimumAmountCents: 5000 },
      "...naming the minimum"
    );
  }
  {
    // Stripe refuses the session for a reason of its own: the code is not
    // blamed, and the drawer keeps it.
    const r = await executeCheckout(
      { items: CART, discount_code: "WELCOME10" },
      { promoCodes: codes, sessionError: true }
    );
    eq(r.status, 400, "Stripe refusing the session for a generic reason is still a 400");
    eq(r.data.promo, undefined, "...that does not blame the code when Stripe did not");
  }
  {
    // Stripe refuses the code itself (a restriction only it can see).
    const r = await executeCheckout(
      { items: CART, discount_code: "WELCOME10" },
      { promoCodes: codes, promoRefused: true }
    );
    eq(r.status, 400, "Stripe refusing the promotion code refuses the checkout");
    eq(
      r.data.promo,
      { code: "WELCOME10", applied: false, reason: "rejected" },
      "...naming the code so the drawer drops it"
    );
    eq(r.data.error, promo.PROMO_COPY.rejected, "...with curated copy, never Stripe's");
  }
  {
    const r = await executeCheckout({ items: CART }, { promoCodes: codes });
    eq(r.sessionParams.get("discounts[0][promotion_code]"), null, "no code: no discount");
    eq(r.sessionParams.get("allow_promotion_codes"), "true", "no code: Stripe's box stays on");
    eq(r.data.promo, undefined, "no code: nothing to report");
  }
  {
    // Stripe unreachable at checkout: refused (retryable), never full price.
    const r = await executeCheckout(
      { items: CART, discount_code: "WELCOME10" },
      { promoCodes: codes, promoLookupDown: true }
    );
    eq(r.status, 503, "Stripe unreachable for the lookup: 503");
    eq(r.data.promo, { code: "WELCOME10", applied: false, reason: "unavailable" }, "...retryable");
    eq(r.sessionParams, null, "...and no full-price session was created behind the shopper");
  }

  /* ------------------------------------- 4. never on a gift card (red team) */
  {
    // A percentage code on the shop's own gift card would sell stored value
    // below par: the card is minted at face value whatever was paid.
    const r = await executePreview(
      {
        code: "WELCOME10",
        items: [{ id: "yallternative-gift-card", qty: 1, variant: "Preset $25" }, ...CART]
      },
      { promoCodes: { WELCOME10: mockPromo("WELCOME10", { percent: 10 }) } }
    );
    eq(r.status, 200, "gift card in the cart: HTTP 200");
    eq(r.data.valid, false, "gift card in the cart: the code is refused");
    eq(r.data.reason, "gift_card_purchase", "...with its own reason");
    eq(r.calls.promo.length, 0, "...before Stripe is asked anything");
  }
  {
    // A code Stripe minted for ONE customer: Checkout refuses it for anyone
    // else, so the drawer must not show a discount first.
    const bound = mockPromo("MINE10", { percent: 10 });
    bound.customer = "cus_someone_else";
    const r = await executePreview(
      { code: "MINE10", items: CART },
      { promoCodes: { MINE10: bound } }
    );
    eq(r.data.valid, false, "a customer-bound code is refused at preview");
    eq(r.data.reason, "not_applicable", "...as not applicable");
  }
  {
    const r = await executeCheckout(
      {
        items: [{ id: "yallternative-gift-card", qty: 1, variant: "Preset $25" }, ...CART],
        discount_code: "WELCOME10"
      },
      { promoCodes: { WELCOME10: mockPromo("WELCOME10", { percent: 10 }) } }
    );
    eq(r.status, 400, "checkout: a code on a cart holding a gift card is refused");
    eq(r.sessionParams, null, "...and no session is created");
    eq(
      r.data.promo,
      { code: "WELCOME10", applied: false, reason: "gift_card_purchase" },
      "...saying why, structurally"
    );
    eq(r.promoLookups.length, 0, "...without asking Stripe for the code");
  }
  {
    const r = await executeCheckout(
      { items: [{ id: "yallternative-gift-card", qty: 1, variant: "Preset $25" }] },
      {}
    );
    eq(r.status, 200, "buying a gift card with no code: HTTP 200");
    eq(
      r.sessionParams.get("allow_promotion_codes"),
      null,
      "...and Stripe's own code box is off for that session too"
    );
    eq(
      r.sessionParams.get("after_expiration[recovery][allow_promotion_codes]"),
      "false",
      "...and off on the abandoned-cart recovery session, which recreates the same lines"
    );
  }
  {
    // The owner switched codes off after this tab loaded its drawer: a
    // refusal the drawer clears, never a 200 that lands on a full-price page.
    const r = await executeCheckout(
      { items: CART, discount_code: "WELCOME10" },
      {
        promoCodes: { WELCOME10: mockPromo("WELCOME10", { percent: 10 }) },
        site: { enablePromoCodes: false }
      }
    );
    eq(r.status, 400, "codes switched off + a code: refused");
    eq(r.sessionParams, null, "...no session");
    eq(
      r.data.promo,
      { code: "WELCOME10", applied: false, reason: "disabled" },
      "...with the reason the drawer maps to its own sentence"
    );
  }

  console.log(`\nworker-promo-preview.test.js: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error("Promo preview test suite error:", err);
  process.exit(1);
});
