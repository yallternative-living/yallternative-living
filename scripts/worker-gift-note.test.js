/**
 * @fileoverview GET /api/gift-note -- the owner's printable gift note.
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

  console.log(`\nworker-gift-note.test.js: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("FAILED:\n  " + failures.join("\n  "));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
