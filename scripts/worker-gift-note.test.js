/**
 * @fileoverview GET /api/gift-note -- the owner's printable gift note -- and
 * the two owner emails the Stripe webhook sends: the gift-note link and the
 * per-order fulfilment copy.
 * Run: node scripts/worker-gift-note.test.js
 *
 * Node-only, no network: Stripe is a stub passed through env.fetchImpl and
 * Resend through the webhook's sendEmail seam.
 */

const assert = require("assert");

let passed = 0;
let failed = 0;
const failures = [];
async function it(desc, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${desc}`);
  } catch (e) {
    failed++;
    failures.push(desc);
    console.log(`  ✗ ${desc}\n    ${e && e.message}`);
  }
}

const SECRET = "test-magic-link-secret-that-is-long-enough";
const SESSION_ID = "cs_test_a1B2c3D4e5F6g7H8";
const ORIGIN = "https://yallternativeliving.com";

function session(metadata, extra) {
  return Object.assign(
    {
      id: SESSION_ID,
      payment_status: "paid",
      status: "complete",
      customer_details: { name: "Savanna Buyer", email: "buyer@example.com" },
      metadata: metadata || {}
    },
    extra || {}
  );
}

function stripeStub(body, status) {
  return async () => ({
    ok: (status || 200) < 400,
    status: status || 200,
    json: async () => body
  });
}

(async () => {
  const mod = await import("../workers/routes/gift-note.js");
  const { giftNoteLink, giftNotesOf, handleGiftNote, renderGiftNoteHtml } = mod;

  console.log("\n--- giftNotesOf ---");
  await it("returns nothing for an order with no gift text", () => {
    assert.deepStrictEqual(giftNotesOf(session({})), []);
    assert.deepStrictEqual(giftNotesOf(session({ is_gift_order: "true", gift_message: "  " })), []);
    assert.deepStrictEqual(giftNotesOf(null), []);
  });
  await it("collects the order-level note and every gift-card note", () => {
    const notes = giftNotesOf(
      session({
        is_gift_order: "true",
        gift_message: "Happy birthday, Jo!",
        gift_card_0_message: "Treat yourself",
        gift_card_0_recipient: "riley.h@example.com",
        gift_card_0_sender: "Sam",
        gift_card_1_message: "",
        gift_card_2_message: "Second card",
        gift_card_2_recipient: "",
        gift_card_2_sender: ""
      })
    );
    assert.strictEqual(notes.length, 3);
    assert.deepStrictEqual(notes[0], {
      kind: "order",
      message: "Happy birthday, Jo!",
      recipient: "",
      sender: ""
    });
    assert.deepStrictEqual(notes[1], {
      kind: "gift-card",
      message: "Treat yourself",
      recipient: "riley.h",
      sender: "Sam"
    });
    assert.strictEqual(notes[2].recipient, "");
  });

  console.log("\n--- giftNoteLink / token ---");
  let link;
  await it("mints a link bound to the session with an expiry and signature", async () => {
    link = await giftNoteLink(SECRET, SESSION_ID, ORIGIN + "/", { now: 1_800_000_000_000 });
    const u = new URL(link);
    assert.strictEqual(u.origin + u.pathname, ORIGIN + "/api/gift-note");
    assert.strictEqual(u.searchParams.get("session_id"), SESSION_ID);
    assert.ok(/^\d+\.[A-Za-z0-9_-]{20,}$/.test(u.searchParams.get("t")), "token shape");
    assert.strictEqual(Number(u.searchParams.get("t").split(".")[0]), 1_800_000_000 + 180 * 86400);
  });
  await it("refuses to mint without a secret or for a non-session id", async () => {
    await assert.rejects(() => giftNoteLink("", SESSION_ID, ORIGIN), /MAGIC_LINK_SECRET/);
    await assert.rejects(() => giftNoteLink(SECRET, "order-123", ORIGIN), /Checkout Session/);
  });

  console.log("\n--- handleGiftNote ---");
  const goodLink = await giftNoteLink(SECRET, SESSION_ID, ORIGIN);
  const env = (over) =>
    Object.assign(
      {
        MAGIC_LINK_SECRET: SECRET,
        STRIPE_SECRET_KEY: "sk_test_x",
        fetchImpl: stripeStub(
          session({
            is_gift_order: "true",
            gift_message: 'Love you <script>alert("x")</script> & more',
            gift_card_0_message: "For the porch nights",
            gift_card_0_recipient: "jo@example.com",
            gift_card_0_sender: "Riley"
          })
        )
      },
      over || {}
    );

  await it("answers 405 to anything but GET", async () => {
    const res = await handleGiftNote(new Request(goodLink, { method: "POST" }), env());
    assert.strictEqual(res.status, 405);
  });
  await it("answers 503 with a plain explanation when the secret is missing", async () => {
    const res = await handleGiftNote(new Request(goodLink), env({ MAGIC_LINK_SECRET: "" }));
    assert.strictEqual(res.status, 503);
    assert.ok(/not set up yet/i.test(await res.text()));
  });
  await it("rejects a missing, malformed, wrong-session or expired token with 403", async () => {
    for (const url of [
      `${ORIGIN}/api/gift-note?session_id=${SESSION_ID}`,
      `${ORIGIN}/api/gift-note?session_id=${SESSION_ID}&t=abc`,
      goodLink.replace(SESSION_ID, "cs_test_someoneelse00"),
      goodLink.replace(/&t=\d+/, "&t=1000")
    ]) {
      const res = await handleGiftNote(new Request(url), env());
      assert.strictEqual(res.status, 403, url);
    }
    const tampered = goodLink.slice(0, -4) + (goodLink.endsWith("AAAA") ? "BBBB" : "AAAA");
    assert.strictEqual((await handleGiftNote(new Request(tampered), env())).status, 403);
  });
  await it("does not call Stripe unless the token checks out", async () => {
    let called = 0;
    const res = await handleGiftNote(
      new Request(`${ORIGIN}/api/gift-note?session_id=${SESSION_ID}&t=1.bad`),
      env({
        fetchImpl: async () => {
          called++;
          return { ok: true, status: 200, json: async () => session({}) };
        }
      })
    );
    assert.strictEqual(res.status, 403);
    assert.strictEqual(called, 0);
  });
  await it("renders one card per note, HTML-escaped, with no prices or codes", async () => {
    const res = await handleGiftNote(new Request(goodLink), env());
    assert.strictEqual(res.status, 200);
    assert.ok(/text\/html/.test(res.headers.get("Content-Type")));
    assert.strictEqual(res.headers.get("Cache-Control"), "no-store");
    assert.ok(/noindex/.test(res.headers.get("X-Robots-Tag")));
    assert.ok(/default-src 'none'/.test(res.headers.get("Content-Security-Policy")));
    const html = await res.text();
    assert.strictEqual((html.match(/class="card"/g) || []).length, 2);
    assert.ok(html.indexOf("<script>") === -1, "script tag escaped");
    assert.ok(html.indexOf("&lt;script&gt;") !== -1);
    assert.ok(html.indexOf("For jo") !== -1, "gift-card recipient greeted by the local part");
    assert.ok(html.indexOf("&mdash; Riley") !== -1, "gift-card sender");
    assert.ok(
      html.indexOf("&mdash; Savanna") !== -1,
      "order note signed with the buyer's first name"
    );
    assert.ok(html.indexOf("window.print()") !== -1, "print button");
    assert.ok(html.indexOf("$") === -1, "no prices");
    assert.ok(!/YALL-/.test(html), "no gift codes");
  });
  await it("says so when the order carries no gift text", async () => {
    const res = await handleGiftNote(
      new Request(goodLink),
      env({ fetchImpl: stripeStub(session({})) })
    );
    assert.strictEqual(res.status, 200);
    assert.ok(/Nothing to print/.test(await res.text()));
  });
  await it("maps Stripe's 404 to a plain not-found page and throws on a 5xx", async () => {
    const res = await handleGiftNote(
      new Request(goodLink),
      env({ fetchImpl: stripeStub({}, 404) })
    );
    assert.strictEqual(res.status, 404);
    await assert.rejects(
      () => handleGiftNote(new Request(goodLink), env({ fetchImpl: stripeStub({}, 500) })),
      /Stripe returned 500/
    );
  });
  await it("refuses a session whose id does not match the link", async () => {
    const res = await handleGiftNote(
      new Request(goodLink),
      env({ fetchImpl: stripeStub(session({}, { id: "cs_test_other0000000" })) })
    );
    assert.strictEqual(res.status, 404);
  });
  await it("renderGiftNoteHtml greets an unnamed recipient generically", () => {
    const html = renderGiftNoteHtml(session({}), [
      { kind: "order", message: "Hi", recipient: "", sender: "" }
    ]);
    assert.ok(html.indexOf("A little something for you") !== -1);
  });

  console.log("\n--- webhook: owner email ---");
  const webhook = await import("../workers/routes/stripe-webhook.js");
  await it("emails the owner a print link for a gift order, once per session", async () => {
    /* sendEmail() talks to Resend through the global fetch. */
    const sent = [];
    const realFetch = global.fetch;
    global.fetch = async (url, init) => {
      sent.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => ({ id: "email_1" }) };
    };
    const wenv = {
      MAGIC_LINK_SECRET: SECRET,
      SITE_ORIGIN: ORIGIN,
      ORDER_NOTIFY_EMAIL: "savanna@example.com",
      RESEND_API_KEY: "re_test"
    };
    let out;
    try {
      out = await webhook.emailGiftNoteLink(
        session({ is_gift_order: "true", gift_message: "Surprise!" }),
        wenv
      );
    } finally {
      global.fetch = realFetch;
    }
    assert.strictEqual(out && out.emailed, "savanna@example.com");
    const resend = sent.filter((s) => /resend\.com/.test(s.url));
    assert.strictEqual(resend.length, 1, "one Resend call");
    const body = JSON.parse(resend[0].init.body);
    assert.strictEqual(body.to, "savanna@example.com");
    assert.ok(/Gift note to print/.test(body.subject));
    assert.ok(body.text.indexOf(`${ORIGIN}/api/gift-note?session_id=${SESSION_ID}&t=`) !== -1);
    assert.strictEqual(resend[0].init.headers["Idempotency-Key"], `gift-note-email-${SESSION_ID}`);
  });
  await it("sends nothing for an order without gift text, and skips without a secret", async () => {
    let calls = 0;
    const realFetch2 = global.fetch;
    global.fetch = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    try {
      const wenv = { MAGIC_LINK_SECRET: SECRET, RESEND_API_KEY: "re_test" };
      assert.strictEqual(await webhook.emailGiftNoteLink(session({}), wenv), null);
      const skipped = await webhook.emailGiftNoteLink(
        session({ is_gift_order: "true", gift_message: "x" }),
        Object.assign({}, wenv, { MAGIC_LINK_SECRET: "" })
      );
      assert.deepStrictEqual(skipped, { skipped: "no-secret" });
    } finally {
      global.fetch = realFetch2;
    }
    assert.strictEqual(calls, 0);
  });

  console.log("\n--- webhook: owner order email ---");
  /* One paid order, as the event hands it over: NO line_items. The Stripe
     stub below serves them on the session read the step makes. */
  const TANK_LINE = {
    description: "Y'allternative Living Tank Top (M)",
    quantity: 1,
    amount_subtotal: 3000,
    amount_total: 3000,
    price: { unit_amount: 3000 }
  };
  const SHIP_TO = {
    name: "Savanna Buyer",
    address: {
      line1: "12 Peach Street",
      line2: "Apt 4",
      city: "Greenville",
      state: "SC",
      postal_code: "29601",
      country: "US"
    }
  };
  const order = (metadata, extra) =>
    session(metadata, {
      amount_subtotal: 3000,
      amount_total: 3000,
      total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
      payment_intent: "pi_test_owner123",
      created: 1_788_459_300, // Sep 3, 2026, 2:15 PM in New York
      collected_information: { shipping_details: SHIP_TO },
      ...(extra || {})
    });
  const completed = (s) => ({
    id: `evt_${s.id}`,
    type: "checkout.session.completed",
    data: { object: s }
  });
  /* STATE_DB is left off on purpose: retention, loyalty and revenue then
     no-op, so what is asserted is this step and the gift-note email only. */
  const ownerEnv = (extra) => ({
    MAGIC_LINK_SECRET: SECRET,
    SITE_ORIGIN: ORIGIN,
    ORDER_NOTIFY_EMAIL: "savanna@example.com",
    RESEND_API_KEY: "re_test",
    STRIPE_SECRET_KEY: "sk_test_owner",
    ...(extra || {})
  });
  /**
   * Swap global.fetch for a recorder. Stripe's session read answers with
   * `options.lines` expanded (or a 500 when `options.stripeFails`); Resend
   * records every send and, for keys matching `options.refuse`, answers as
   * `options.refuseWith` (a response, or a thrown error). products.json and
   * content.json are unreachable, so the size question stays quiet.
   */
  async function withOwnerMocks(options, fn) {
    const original = global.fetch;
    const calls = { stripe: [], resend: [] };
    global.fetch = async (url, init) => {
      const u = String(url);
      if (/api\.stripe\.com\/v1\/checkout\/sessions\//.test(u)) {
        calls.stripe.push({ url: new URL(u), init });
        if (options.stripeFails) return { ok: false, status: 500, json: async () => ({}) };
        const id = decodeURIComponent(u.split("/checkout/sessions/")[1].split("?")[0]);
        return {
          ok: true,
          status: 200,
          json: async () => ({ id, line_items: { data: options.lines || [TANK_LINE] } })
        };
      }
      if (/api\.resend\.com/.test(u)) {
        const headers = (init && init.headers) || {};
        const call = { body: JSON.parse((init && init.body) || "{}"), headers };
        calls.resend.push(call);
        if (options.refuse && options.refuse.test(headers["Idempotency-Key"] || "")) {
          if (options.refuseWith instanceof Error) throw options.refuseWith;
          return options.refuseWith || { ok: false, status: 500, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({ id: "email_o" }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    try {
      return await fn(calls);
    } finally {
      global.fetch = original;
    }
  }
  const ownerMails = (calls) =>
    calls.resend.filter((c) => /^owner-order-email-/.test(c.headers["Idempotency-Key"] || ""));

  await it("emails the owner one fulfilment copy of a paid order: lines, total, full address", async () => {
    await withOwnerMocks({}, async (calls) => {
      const s = order({ retention_product_ids: "tank-top" });
      const out = await webhook.processStripeEvent(completed(s), ownerEnv(), null);
      assert.strictEqual(calls.stripe.length, 1, "one Stripe read for the line items");
      assert.deepStrictEqual(calls.stripe[0].url.searchParams.getAll("expand[]"), ["line_items"]);
      assert.ok(calls.stripe[0].url.pathname.endsWith(`/checkout/sessions/${SESSION_ID}`));
      const mails = ownerMails(calls);
      assert.strictEqual(mails.length, 1, "exactly one owner email");
      const { body } = mails[0];
      assert.strictEqual(body.to, "savanna@example.com");
      assert.strictEqual(body.reply_to, "contact@yallternativeliving.com");
      assert.strictEqual(body.subject, "New order $30 -- 1× Y'allternative Living Tank Top (M)");
      assert.ok(
        body.text.includes("1× Y'allternative Living Tank Top (M) -- $30 each, $30"),
        "the line carries qty, variant, unit price and line total"
      );
      assert.ok(/Total:\s+\$30\n/.test(body.text), "the order total");
      assert.ok(/Shipping:\s+Free\n/.test(body.text), "free shipping is said, not hidden");
      assert.ok(
        body.text.includes("Buyer: Savanna Buyer <buyer@example.com>"),
        "buyer name and email"
      );
      for (const part of [
        "Savanna Buyer",
        "12 Peach Street",
        "Apt 4",
        "Greenville, SC 29601",
        "US"
      ]) {
        assert.ok(body.text.includes(part), `ship-to line: ${part}`);
      }
      assert.ok(
        body.text.includes("https://dashboard.stripe.com/payments/pi_test_owner123"),
        "the Dashboard link to the payment"
      );
      assert.ok(body.text.includes(`Session: ${SESSION_ID}`));
      assert.ok(
        body.text.includes("Sep 3, 2026, 2:15 PM ET"),
        "the order date, in the shop's zone"
      );
      assert.ok(
        !/Gift note/.test(body.text) && !/Gift note/.test(body.html),
        "no gift block on a plain order"
      );
      assert.ok(body.html.includes("Y&#39;allternative Living Tank Top (M)"), "html is escaped");
      assert.ok(body.html.includes("12 Peach Street"), "html carries the address too");
      assert.deepStrictEqual(out.ownerNotice, {
        emailed: "savanna@example.com",
        ok: true,
        lines: 1
      });
    });
  });

  await it("keys the owner email owner-order-email-<session id> at Resend", async () => {
    await withOwnerMocks({}, async (calls) => {
      await webhook.processStripeEvent(completed(order({})), ownerEnv(), null);
      const mail = ownerMails(calls)[0];
      assert.ok(mail, "the owner email went out");
      assert.strictEqual(mail.headers["Idempotency-Key"], `owner-order-email-${SESSION_ID}`);
      assert.strictEqual(mail.body.headers["X-Entity-Ref-ID"], `owner-order-email-${SESSION_ID}`);
    });
  });

  await it("a Resend failure on the owner copy never rejects the webhook", async () => {
    const gift = () => order({ is_gift_order: "true", gift_message: "Surprise!" });
    /* A refusal (non-2xx)... */
    await withOwnerMocks({ refuse: /^owner-order-email-/ }, async (calls) => {
      const out = await webhook.processStripeEvent(completed(gift()), ownerEnv(), null);
      assert.strictEqual(out.type, "checkout.session.completed", "the outcome is returned");
      assert.deepStrictEqual(out.ownerNotice, {
        emailed: "savanna@example.com",
        ok: false,
        lines: 1
      });
      assert.strictEqual(
        out.giftNote && out.giftNote.emailed,
        "savanna@example.com",
        "the gift-note email still went"
      );
      assert.strictEqual(ownerMails(calls).length, 1, "it was attempted once");
    });
    /* ...and a thrown network error. */
    await withOwnerMocks(
      { refuse: /^owner-order-email-/, refuseWith: new Error("resend is down") },
      async (calls) => {
        const out = await webhook.processStripeEvent(completed(gift()), ownerEnv(), null);
        assert.strictEqual(out.ownerNotice.ok, false);
        assert.strictEqual(out.giftNote && out.giftNote.emailed, "savanna@example.com");
        assert.strictEqual(calls.resend.length, 2, "both sends were attempted");
      }
    );
  });

  await it("a pick-up order says where, and prints no street address", async () => {
    await withOwnerMocks({}, async (calls) => {
      const s = order(
        { pickup_market: "Sat, Oct 3 -- Landrum Farmers Market" },
        {
          collected_information: undefined,
          customer_details: {
            name: "Savanna Buyer",
            email: "buyer@example.com",
            address: SHIP_TO.address
          }
        }
      );
      await webhook.processStripeEvent(completed(s), ownerEnv(), null);
      const { body } = ownerMails(calls)[0];
      assert.ok(body.text.includes("Local pick-up at Sat, Oct 3 -- Landrum Farmers Market"));
      assert.ok(body.html.includes("Local pick-up at"));
      assert.ok(
        !body.text.includes("12 Peach Street") && !body.html.includes("12 Peach Street"),
        "no street"
      );
      assert.ok(!body.text.includes("29601"), "no postcode");
      assert.ok(!/Shipping:/.test(body.text), "no shipping row on a pick-up");
    });
  });

  await it("an unpaid or expired session gets the owner nothing", async () => {
    for (const [payment_status, status] of [
      ["unpaid", "open"],
      ["unpaid", "expired"],
      [undefined, "complete"]
    ]) {
      await withOwnerMocks({}, async (calls) => {
        const out = await webhook.processStripeEvent(
          completed(order({}, { payment_status, status })),
          ownerEnv(),
          null
        );
        assert.strictEqual(
          ownerMails(calls).length,
          0,
          `${payment_status}/${status}: no owner email`
        );
        assert.strictEqual(calls.stripe.length, 0, "and no Stripe read either");
        assert.strictEqual(
          out.ownerNotice.skipped,
          `payment-status-${payment_status || "unknown"}`
        );
      });
    }
    /* A 100%-gift-card order captured nothing but still has to be packed. */
    await withOwnerMocks({}, async (calls) => {
      await webhook.processStripeEvent(
        completed(order({}, { payment_status: "no_payment_required", amount_total: 0 })),
        ownerEnv(),
        null
      );
      assert.strictEqual(ownerMails(calls).length, 1, "no_payment_required is still an order");
    });
  });

  await it("carries the gift note itself -- recipient, sender and message, verbatim and escaped", async () => {
    await withOwnerMocks({}, async (calls) => {
      const s = order({
        is_gift_order: "true",
        gift_message: "Happy birthday, Jo <3",
        // No `_amount_cents`: that key is what makes issuePurchasedCards mint a
        // card, and the ledger is not this suite's subject. The owner copy
        // reads the note fields alone.
        gift_card_1_recipient: "jo@example.com",
        gift_card_1_sender: "Riley",
        gift_card_1_message: "Treat yourself & rest",
        custom_box_1: "Frankincense Salve, Hand Scrub",
        gift_set_1: "Grit & Grace Starter Set: Frankincense Salve — Size: 2 oz"
      });
      await webhook.processStripeEvent(completed(s), ownerEnv(), null);
      const { body } = ownerMails(calls)[0];
      const gift = body.text.indexOf("Gift note");
      const ship = body.text.indexOf("Ship to:");
      assert.ok(
        gift !== -1 && ship !== -1 && gift < ship,
        "the gift block comes before the address"
      );
      assert.ok(body.text.includes('"Happy birthday, Jo <3"'), "the order-level note, verbatim");
      assert.ok(body.text.includes("To: jo@example.com"), "the card's recipient, in full");
      assert.ok(body.text.includes("From: Riley"), "the card's sender");
      assert.ok(body.text.includes('"Treat yourself & rest"'), "the card's message");
      assert.ok(body.html.includes("Happy birthday, Jo &lt;3"), "html-escaped");
      assert.ok(body.html.includes("Treat yourself &amp; rest"));
      assert.ok(
        body.text.includes("Box 1 contents: Frankincense Salve, Hand Scrub"),
        "box contents"
      );
      assert.ok(body.text.includes("Set choices: Grit & Grace Starter Set"), "gift-set choices");
    });
    await withOwnerMocks({}, async (calls) => {
      await webhook.processStripeEvent(completed(order({})), ownerEnv(), null);
      const { body } = ownerMails(calls)[0];
      assert.ok(
        !body.text.includes("Gift note") && !body.html.includes("Gift note"),
        "no heading without gift fields"
      );
    });
  });

  await it("still sends, and says so, when Stripe will not give up the line items", async () => {
    await withOwnerMocks({ stripeFails: true }, async (calls) => {
      const out = await webhook.processStripeEvent(
        completed(
          order(
            {},
            {
              total_details: { amount_discount: 500, amount_shipping: 600 },
              amount_total: 3100,
              metadata: { discount_code: "WELCOME10", gift_card_amount_applied_cents: "0" }
            }
          )
        ),
        ownerEnv(),
        null
      );
      const { body } = ownerMails(calls)[0];
      assert.strictEqual(body.subject, `New order $31 -- order ${SESSION_ID}`);
      assert.ok(body.text.includes("Line items could not be read from Stripe"));
      assert.ok(/Discount:\s+-\$5 \(WELCOME10\)/.test(body.text), "discount and code");
      assert.ok(/Shipping:\s+\$6\n/.test(body.text));
      assert.deepStrictEqual(out.ownerNotice, {
        emailed: "savanna@example.com",
        ok: true,
        lines: null
      });
    });
  });

  console.log(`\nworker-gift-note.test.js: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("FAILED:\n  " + failures.join("\n  "));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
