/**
 * @fileoverview The two order automations:
 *   - workers/routes/order-digest.js      the owner's once-a-day pick list
 *   - workers/routes/stripe-webhook.js    the buyer's size/scent question
 *
 * Node only, no network, no wrangler: D1 is the `node:sqlite` emulator
 * (scripts/lib/d1-emulator.js) with the real migrations applied, and Stripe,
 * Resend, products.json and content.json are all served by one `global.fetch`
 * recorder. The jobs are driven through their real exported entry points --
 * `runOrderDigest` and `processStripeEvent` -- so the wiring is under test and
 * not a re-implementation of it.
 *
 * Run: node scripts/worker-order-digest.test.js
 */

const { DatabaseSync } = require("node:sqlite");
const { makeD1 } = require("./lib/d1-emulator.js");

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
  }
}

/* ------------------------------------------------------------- fixtures */

const SITE = "https://yallternativeliving.com";
const SECRET = "order-digest-suite-signing-secret";
/** 2026-09-01 12:00 America/New_York -- past the 7am gate, same NY day. */
const NOON_NY = Date.UTC(2026, 8, 1, 16, 0, 0);
/** 2026-09-01 05:00 America/New_York -- before it. */
const DAWN_NY = Date.UTC(2026, 8, 1, 9, 0, 0);

const catalog = {
  products: [
    {
      id: "frankincense-salve",
      name: "Frankincense Salve",
      category: "salves",
      price: 18,
      variants: { name: "Size", options: [{ label: "2 oz" }, { label: "4 oz" }] }
    },
    { id: "hand-scrub", name: "Hand Scrub", category: "scrubs", price: 14 },
    { id: "bug-spray", name: "Bug Spray", category: "sprays", price: 12 },
    {
      id: "tank-top",
      name: "Y'allternative Living Tank Top",
      category: "apparel",
      price: 30,
      variants: {
        name: "Size",
        options: [{ label: "S", soldOut: true }, { label: "M" }, { label: "L" }]
      }
    },
    {
      id: "yallternative-gift-card",
      name: "Y'allternative Gift Card",
      category: "gift-cards",
      price: 10,
      variants: { name: "Amount", options: [{ label: "Preset $25" }] }
    }
  ],
  bundles: [
    {
      id: "starter-self-care-set",
      name: "Grit & Grace Starter Set",
      productIds: ["frankincense-salve", "hand-scrub", "bug-spray"]
    },
    { id: "plain-duo", name: "Plain Duo", productIds: ["hand-scrub", "bug-spray"] }
  ]
};

const content = {
  site: {
    enableOrderDigest: true,
    automations: {
      orderDigestHour: 7,
      sizeConfirmationIntro: "Your set is on the bench, and two pieces come in more than one size."
    }
  }
};

const BUYER = {
  name: "Riley Jo Parker",
  email: "riley.parker@example.com",
  address: { line1: "12 Peach Street", city: "Landrum", state: "SC", postal_code: "29356" }
};

function session(id, extra) {
  return {
    id,
    status: "complete",
    payment_status: "paid",
    customer_details: BUYER,
    metadata: {},
    line_items: { data: [] },
    ...extra
  };
}

const BUNDLE_ORDER = session("cs_test_bundleorder01", {
  line_items: { data: [{ description: "Grit & Grace Starter Set", quantity: 1 }] },
  metadata: { retention_product_ids: "starter-self-care-set" }
});

const BOX_GIFT_PICKUP_ORDER = session("cs_test_boxgiftorder2", {
  line_items: {
    data: [
      { description: "Build-Your-Own Box (2 items)", quantity: 1 },
      { description: "Y'allternative Living Tank Top (M)", quantity: 2 }
    ]
  },
  metadata: {
    custom_box_1: "Frankincense Salve, Hand Scrub",
    is_gift_order: "true",
    gift_message: "Happy birthday, Jo",
    pickup_market: "Sat, Oct 3 -- Landrum Farmers Market",
    retention_product_ids: "frankincense-salve,hand-scrub,tank-top"
  }
});

const UNPAID_ORDER = session("cs_test_unpaidorder03", {
  payment_status: "unpaid",
  line_items: { data: [{ description: "Hand Scrub", quantity: 1 }] }
});

const PLAIN_ORDER = session("cs_test_plainorder004", {
  line_items: { data: [{ description: "Hand Scrub", quantity: 3 }] },
  metadata: { retention_product_ids: "hand-scrub" }
});

/* --------------------------------------------------------------- harness */

async function makeEnv(overrides = {}) {
  const { applyMigrations, resetSchemaMemo } = await import("../workers/state/migrations.js");
  resetSchemaMemo();
  const db = makeD1(new DatabaseSync(":memory:"));
  await applyMigrations(db);
  return {
    SITE_ORIGIN: SITE,
    STRIPE_SECRET_KEY: "sk_test_digest",
    STRIPE_WEBHOOK_SECRET: "whsec_digest",
    RESEND_API_KEY: "re_test_digest",
    MAGIC_LINK_SECRET: SECRET,
    ORDER_NOTIFY_EMAIL: "savanna@example.com",
    STATE_DB: db,
    ...overrides
  };
}

/**
 * Swap global.fetch for a recorder. `options.pages` is the sequence of Stripe
 * list responses; `options.site` overrides content.json.
 */
async function withMocks(options, fn) {
  const original = global.fetch;
  const calls = { lists: [], resend: [] };
  let page = 0;
  const pages = options.pages || [];
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("products.json")) {
      return { ok: true, status: 200, json: async () => options.catalog || catalog };
    }
    if (u.includes("content.json")) {
      return { ok: true, status: 200, json: async () => options.content || content };
    }
    if (u.includes("api.stripe.com/v1/checkout/sessions")) {
      calls.lists.push(new URL(u));
      const body = pages[page] || { data: [], has_more: false };
      page += 1;
      if (options.stripeFails) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => body };
    }
    if (u.includes("api.resend.com")) {
      calls.resend.push({
        body: JSON.parse((init && init.body) || "{}"),
        headers: (init && init.headers) || {}
      });
      return { ok: true, status: 200, json: async () => ({ id: "re_1" }) };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    return await fn(calls);
  } finally {
    global.fetch = original;
  }
}

const onePage = (sessions) => [{ data: sessions, has_more: false }];

(async () => {
  const digest = await import("../workers/routes/order-digest.js");
  const webhook = await import("../workers/routes/stripe-webhook.js");

  /* =================================================== listing and window */
  console.log("\n--- the Stripe query ---");
  {
    const env = await makeEnv();
    await withMocks({ pages: onePage([BUNDLE_ORDER]) }, async (calls) => {
      await digest.runOrderDigest(env, null, NOON_NY);
      eq(calls.lists.length, 1, "one Stripe list request");
      const q = calls.lists[0].searchParams;
      eq(q.get("status"), "complete", "asks Stripe for completed sessions only");
      eq(q.getAll("expand[]"), ["data.line_items"], "expands the line items");
      eq(q.get("limit"), "100", "takes full pages");
      const gte = Number(q.get("created[gte]"));
      eq(
        Math.round((NOON_NY / 1000 - gte) / 3600),
        digest.DIGEST_WINDOW_HOURS,
        "the window reaches back 26 hours, not 24 -- a missed tick still recovers"
      );
      assert(!calls.lists[0].search.includes("starting_after"), "no cursor on the first page");
    });
  }

  console.log("\n--- pagination ---");
  {
    const env = await makeEnv();
    await withMocks(
      {
        pages: [
          { data: [PLAIN_ORDER, UNPAID_ORDER], has_more: true },
          { data: [BOX_GIFT_PICKUP_ORDER, BUNDLE_ORDER], has_more: false }
        ]
      },
      async (calls) => {
        const out = await digest.runOrderDigest(env, null, NOON_NY);
        eq(calls.lists.length, 2, "walks both pages");
        eq(
          calls.lists[1].searchParams.get("starting_after"),
          UNPAID_ORDER.id,
          "pages with starting_after set to the last id of the previous page"
        );
        eq(out.orders, 3, "three paid orders across two pages (the unpaid one is dropped)");
        const text = calls.resend[0].body.text;
        assert(text.includes(BUNDLE_ORDER.id), "the second page's orders are in the email");
        assert(!text.includes(UNPAID_ORDER.id), "an unpaid session is never listed");
      }
    );
  }

  console.log("\n--- dedupe against the previous digest ---");
  {
    const env = await makeEnv();
    const state = await import("../workers/state/job-state.js");
    await state.setJobState(env.STATE_DB, digest.DIGEST_CURSOR_JOB, BOX_GIFT_PICKUP_ORDER.id);
    await withMocks(
      { pages: onePage([PLAIN_ORDER, UNPAID_ORDER, BOX_GIFT_PICKUP_ORDER, BUNDLE_ORDER]) },
      async (calls) => {
        const out = await digest.runOrderDigest(env, null, NOON_NY);
        eq(out.orders, 1, "stops at the id remembered from the previous run");
        const text = calls.resend[0].body.text;
        assert(text.includes(PLAIN_ORDER.id), "the order newer than the marker is reported");
        assert(
          !text.includes(BOX_GIFT_PICKUP_ORDER.id) && !text.includes(BUNDLE_ORDER.id),
          "nothing at or before the marker is reported a second time"
        );
        eq(
          await state.getJobState(env.STATE_DB, digest.DIGEST_CURSOR_JOB),
          PLAIN_ORDER.id,
          "the marker advances to the newest session seen"
        );
      }
    );
  }

  /* ============================================================ the email */
  console.log("\n--- what the digest says ---");
  {
    const env = await makeEnv();
    await withMocks(
      { pages: onePage([BOX_GIFT_PICKUP_ORDER, BUNDLE_ORDER, PLAIN_ORDER]) },
      async (calls) => {
        const out = await digest.runOrderDigest(env, null, NOON_NY);
        eq(out.sent, true, "one email goes out");
        eq(calls.resend.length, 1, "exactly one email for the whole day");
        const mail = calls.resend[0].body;
        const text = mail.text;

        assert(/3 orders to pack/.test(mail.subject), `subject names the count: ${mail.subject}`);
        eq(
          calls.resend[0].headers["Idempotency-Key"],
          "order-digest-2026-09-01",
          "the idempotency key is one per New York day"
        );
        eq(mail.to, "savanna@example.com", "goes to ORDER_NOTIFY_EMAIL");

        // Bundle expansion.
        assert(
          text.includes("1 x Grit & Grace Starter Set"),
          "the bundle line is listed as Stripe named it"
        );
        for (const part of ["Frankincense Salve", "Hand Scrub", "Bug Spray"]) {
          assert(text.includes(`- ${part}`), `the bundle is expanded into ${part}`);
        }
        // Custom-box expansion, from the metadata checkout.js wrote.
        assert(text.includes("1 x Build-Your-Own Box (2 items)"), "the box line is listed");
        assert(
          text.split("Build-Your-Own Box (2 items)")[1].includes("- Frankincense Salve"),
          "the box is expanded from custom_box_1"
        );
        // Quantities and resolved variants.
        assert(
          text.includes("2 x Y'allternative Living Tank Top (M)"),
          "a plain line keeps its quantity and its chosen size"
        );
        assert(text.includes("3 x Hand Scrub"), "the plain order's quantity is right");

        // Variant detection.
        const bundleBlock = text
          .split("\n\n")
          .find((b) => b.startsWith(`Riley -- Landrum, SC (${BUNDLE_ORDER.id})`));
        assert(
          /NEEDS SIZE\/SCENT CONFIRMATION: Frankincense Salve \(2 oz \/ 4 oz\)/.test(bundleBlock),
          "the bundle order is flagged for the salve, with its options"
        );
        assert(
          !/Hand Scrub \(/.test(bundleBlock),
          "a bundled product with no variants is not flagged"
        );
        const plainBlock = text
          .split("\n\n")
          .find((b) => b.startsWith(`Riley -- Landrum, SC (${PLAIN_ORDER.id})`));
        assert(
          plainBlock.includes("3 x Hand Scrub") && !plainBlock.includes("NEEDS SIZE/SCENT"),
          "an order of one variant-less product is listed and not flagged"
        );

        // Gift and pickup. (Split on blank lines, not on the id: the id also
        // appears inside the gift-note URL.)
        const blockFor = (id) =>
          text.split("\n\n").find((b) => b.startsWith(`Riley -- Landrum, SC (${id})`)) || "";
        const giftBlock = blockFor(BOX_GIFT_PICKUP_ORDER.id);
        assert(
          /GIFT -- print the note: https:\/\/yallternativeliving\.com\/api\/gift-note\?session_id=cs_test_boxgiftorder2&t=\d+\./.test(
            giftBlock
          ),
          "the gift order carries the signed printable-note link"
        );
        assert(
          giftBlock.includes("PICKUP: Sat, Oct 3 -- Landrum Farmers Market"),
          "the local-pickup market is shown"
        );
        assert(
          !text.includes("Happy birthday, Jo"),
          "the gift MESSAGE stays in the link, not in the digest"
        );
        assert(
          !blockFor(BUNDLE_ORDER.id).includes("GIFT"),
          "a non-gift order gets no gift line and no print link"
        );
        eq(
          (text.match(/api\/gift-note/g) || []).length,
          1,
          "exactly one gift-note link, for the one gift order"
        );

        // PII boundary.
        const whole = `${mail.subject}\n${mail.text}\n${mail.html}`;
        for (const secret of [
          "riley.parker@example.com",
          "12 Peach Street",
          "29356",
          "Parker",
          "Riley Jo"
        ]) {
          assert(!whole.includes(secret), `the digest never prints "${secret}"`);
        }
        assert(whole.includes("Riley -- Landrum, SC"), "first name and city/state only");
      }
    );
  }

  console.log("\n--- an unreachable catalogue still sends ---");
  {
    const env = await makeEnv();
    await withMocks({ pages: onePage([BUNDLE_ORDER]), catalog: null }, async (calls) => {
      const out = await digest.runOrderDigest(env, null, NOON_NY);
      eq(out.sent, true, "products.json missing does not lose the digest");
      assert(
        calls.resend[0].body.text.includes("1 x Grit & Grace Starter Set"),
        "the Stripe line name is still listed, just unexpanded"
      );
    });
  }

  /* ============================================================== gating */
  console.log("\n--- once a day, at the configured hour, and only when enabled ---");
  {
    const env = await makeEnv();
    await withMocks(
      { pages: [...onePage([BUNDLE_ORDER]), ...onePage([BUNDLE_ORDER])] },
      async (calls) => {
        const first = await digest.runOrderDigest(env, null, NOON_NY);
        const second = await digest.runOrderDigest(env, null, NOON_NY + 3600 * 1000);
        eq(first.sent, true, "the first tick of the day sends");
        eq(second, { skipped: "not-claimed" }, "the next hour's tick sends nothing");
        eq(calls.resend.length, 1, "one email, not twenty-four");
        eq(calls.lists.length, 1, "and the skipped tick costs no Stripe call");
      }
    );
  }
  {
    const env = await makeEnv();
    await withMocks({ pages: onePage([BUNDLE_ORDER]) }, async (calls) => {
      const out = await digest.runOrderDigest(env, null, DAWN_NY);
      eq(out, { skipped: "not-claimed" }, "5am is before the configured 7am hour");
      eq(calls.resend.length, 0, "nothing sent before the hour");
    });
  }
  {
    const env = await makeEnv();
    const off = { site: { ...content.site, enableOrderDigest: false } };
    await withMocks({ pages: onePage([BUNDLE_ORDER]), content: off }, async (calls) => {
      const out = await digest.runOrderDigest(env, null, NOON_NY);
      eq(out, { skipped: "disabled" }, "site.enableOrderDigest = false switches it off");
      eq(calls.resend.length, 0, "nothing sent when it is off");
      eq(calls.lists.length, 0, "and Stripe is never called");
      const state = await import("../workers/state/job-state.js");
      eq(
        await state.getJobState(env.STATE_DB, digest.DIGEST_JOB),
        null,
        "a switched-off run does not burn the day"
      );
    });
  }
  {
    // A later hour in content.json is honoured.
    const env = await makeEnv();
    const late = { site: { ...content.site, automations: { orderDigestHour: 20 } } };
    await withMocks({ pages: onePage([BUNDLE_ORDER]), content: late }, async (calls) => {
      const out = await digest.runOrderDigest(env, null, NOON_NY);
      eq(out, { skipped: "not-claimed" }, "noon is before a configured 8pm hour");
      eq(calls.resend.length, 0, "nothing sent yet");
    });
  }

  console.log("\n--- no orders ---");
  {
    const env = await makeEnv();
    await withMocks({ pages: onePage([]) }, async (calls) => {
      const out = await digest.runOrderDigest(env, null, NOON_NY);
      eq(out, { sent: false, orders: 0 }, "a quiet day sends nothing at all");
      eq(calls.resend.length, 0, "no 'No new orders' email unless it was asked for");
    });
  }
  {
    const env = await makeEnv({ ORDER_DIGEST_WHEN_EMPTY: "true" });
    await withMocks({ pages: onePage([]) }, async (calls) => {
      const out = await digest.runOrderDigest(env, null, NOON_NY);
      eq(out.sent, true, "ORDER_DIGEST_WHEN_EMPTY sends the quiet-day note");
      assert(/No new orders/.test(calls.resend[0].body.subject), "and it says so in the subject");
    });
  }

  console.log("\n--- refuses to run half-configured ---");
  {
    eq(
      await digest.runOrderDigest({ STATE_DB: null }, null, NOON_NY),
      { skipped: "no-state-db" },
      "without D1 there is no once-a-day marker, so it does not run at all"
    );
    const noKey = await makeEnv({ STRIPE_SECRET_KEY: "" });
    eq(
      await digest.runOrderDigest(noKey, null, NOON_NY),
      { skipped: "no-stripe-key" },
      "no Stripe key, no digest"
    );
    const noResend = await makeEnv({ RESEND_API_KEY: "" });
    eq(
      await digest.runOrderDigest(noResend, null, NOON_NY),
      { skipped: "no-resend-key" },
      "no Resend key, no digest"
    );
  }

  /* ================================================ the size/scent email */
  console.log("\n--- size/scent confirmation (webhook) ---");
  const completed = (s) => ({
    id: `evt_${s.id}`,
    type: "checkout.session.completed",
    data: { object: s }
  });
  // STATE_DB is left off on purpose: the retention and loyalty steps then
  // no-op, so what is asserted below is this step and nothing else.
  const hookEnv = () => ({
    SITE_ORIGIN: SITE,
    RESEND_API_KEY: "re_test_digest",
    STRIPE_WEBHOOK_SECRET: "whsec_digest"
  });
  // The same event also sends the owner her per-order copy
  // (scripts/worker-gift-note.test.js covers it); only the size question is
  // this section's subject, so the Resend calls are picked out by their key.
  const sizeMails = (calls) =>
    calls.resend.filter((c) => /^size-confirm-/.test(c.headers["Idempotency-Key"] || ""));

  {
    await withMocks({}, async (calls) => {
      const out = await webhook.processStripeEvent(completed(BUNDLE_ORDER), hookEnv(), null);
      eq(sizeMails(calls).length, 1, "a bundle with an unresolved size gets exactly one email");
      const mail = sizeMails(calls)[0];
      eq(mail.body.to, BUYER.email, "it goes to the buyer");
      eq(
        mail.body.reply_to,
        "contact@yallternativeliving.com",
        "reply-to is the shop, so an answer lands where a human reads it"
      );
      eq(
        mail.headers["Idempotency-Key"],
        `size-confirm-${BUNDLE_ORDER.id}`,
        "one idempotency key per session, so a redelivery cannot ask twice"
      );
      assert(
        mail.body.text.includes(content.site.automations.sizeConfirmationIntro),
        "the opening line is the CMS one (site.automations.sizeConfirmationIntro)"
      );
      assert(
        mail.body.text.includes("Frankincense Salve: 2 oz / 4 oz"),
        "it names the product and its options"
      );
      assert(!/Hand Scrub|Bug Spray/.test(mail.body.text), "and nothing that needs no choice");
      assert(
        !/unsubscribe/i.test(`${mail.body.text}${mail.body.html}`),
        "transactional: no unsubscribe link"
      );
      eq(out.sizeConfirmation.products, ["frankincense-salve"], "the outcome names what it asked");
    });
  }
  {
    await withMocks({}, async (calls) => {
      await webhook.processStripeEvent(completed(BOX_GIFT_PICKUP_ORDER), hookEnv(), null);
      const sizeMail = calls.resend.filter((c) =>
        /size-confirm/.test(c.headers["Idempotency-Key"] || "")
      );
      eq(sizeMail.length, 1, "a build-your-own box asks too");
      assert(
        sizeMail[0].body.text.includes("Frankincense Salve"),
        "expanded from the box contents in metadata"
      );
      assert(
        !sizeMail[0].body.text.includes("Tank Top"),
        "the tank top already carries its size on the line, so it is not asked about"
      );
    });
  }
  {
    await withMocks({}, async (calls) => {
      const out = await webhook.processStripeEvent(completed(PLAIN_ORDER), hookEnv(), null);
      eq(sizeMails(calls).length, 0, "a plain order is never asked anything");
      eq(out.sizeConfirmation, null, "and the step reports nothing to do");
    });
  }
  {
    const noVariants = session("cs_test_plainbundle05", {
      line_items: { data: [{ description: "Plain Duo", quantity: 1 }] },
      metadata: { retention_product_ids: "plain-duo" }
    });
    await withMocks({}, async (calls) => {
      await webhook.processStripeEvent(completed(noVariants), hookEnv(), null);
      eq(sizeMails(calls).length, 0, "a bundle whose contents have no variants asks nothing");
    });
  }
  {
    const noEmail = session("cs_test_noemailorder6", {
      customer_details: { name: "Anon" },
      line_items: { data: [{ description: "Grit & Grace Starter Set", quantity: 1 }] },
      metadata: { retention_product_ids: "starter-self-care-set" }
    });
    await withMocks({}, async (calls) => {
      const out = await webhook.processStripeEvent(completed(noEmail), hookEnv(), null);
      eq(sizeMails(calls).length, 0, "no buyer address, no email");
      eq(out.sizeConfirmation, { skipped: "no-buyer-email" }, "and it says why");
    });
  }
  {
    // The digest's own view of the same order, without going near Stripe.
    const cat = await (async () => {
      const original = global.fetch;
      global.fetch = async () => ({ ok: true, status: 200, json: async () => catalog });
      try {
        return await digest.loadOrderCatalog({ SITE_ORIGIN: SITE }, null);
      } finally {
        global.fetch = original;
      }
    })();
    const giftCardOnly = session("cs_test_giftcardonly7", {
      line_items: { data: [{ description: "Y'allternative Gift Card ($25.00)", quantity: 1 }] },
      metadata: { retention_product_ids: "yallternative-gift-card" }
    });
    eq(
      digest.describeOrder(giftCardOnly, cat).needsConfirmation,
      [],
      "a gift card has 'variants' (the presets) but is never a size question"
    );
    eq(
      digest.productsNeedingChoice(BUNDLE_ORDER, cat).map((p) => p.via),
      ["Grit & Grace Starter Set"],
      "the metadata-only detector names the bundle the product came in"
    );
  }

  console.log(`\nworker-order-digest.test.js: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("FAILED:\n  " + failures.join("\n  "));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
