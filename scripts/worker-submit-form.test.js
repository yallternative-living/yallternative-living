/**
 * @fileoverview Unit tests for the confirmation email in workers/submit-form.js
 * (the optional contact/review form Worker that would replace Formspree).
 *
 * Same harness as scripts/worker-restock.test.js: no network, no wrangler. Only
 * Resend and Turnstile are mocked; the rate limiter is the real RateLimitCounter
 * Durable Object on the d1-emulator namespace, and every request goes through
 * the Worker's REAL default export.
 *
 * What is under test:
 *   - the shop is notified FIRST, and the sender's confirmation is sent only
 *     once that notification was accepted;
 *   - a failed notification is a failure to the caller and sends nothing else;
 *   - a failed confirmation is NOT a failure to the caller;
 *   - the confirmation is plain text, reply_to the shop, and carries nothing
 *     the visitor typed;
 *   - the live forms' Formspree field names (`_replyto`, `_gotcha`) work;
 *   - a review without an email is delivered and gets no confirmation;
 *   - the per-IP and per-recipient limits, and that a refused request sends
 *     nothing;
 *   - CRLF from form encoding is normalised to LF, and a header can't be split;
 *   - every promise in the confirmation copy is one the site already makes.
 *
 * Run: node scripts/worker-submit-form.test.js
 */

const fs = require("fs");
const path = require("path");
const { makeNamespace } = require("./lib/d1-emulator.js");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
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
    console.error(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
  }
}

/* ==========================================================================
   Fixtures and harness
   ========================================================================== */

const ROOT = path.resolve(__dirname, "..");
const SITE = "https://yallternativeliving.com";
const SHOP = "shop@yallternativeliving.com";

let ipCounter = 0;
function freshIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 250}`;
}

async function makeEnv(overrides = {}) {
  const { RateLimitCounter } = await import("../workers/state/rate-limit.js");
  return {
    SITE_ORIGIN: SITE,
    RESEND_API_KEY: "re_test_forms",
    TURNSTILE_SECRET_KEY: "turnstile_test_secret",
    TO_EMAIL: SHOP,
    FROM_EMAIL: "Y'allternative Living <forms@yallternativeliving.com>",
    RATE_LIMIT_COUNTER: makeNamespace(RateLimitCounter),
    ...overrides
  };
}

/**
 * Swap global.fetch for a recorder answering Turnstile and Resend.
 * `resend` is a function of the call index (0 = notification, 1 = confirmation)
 * returning the response, so each send can be failed on its own.
 */
async function withMocks(fn, options = {}) {
  const original = global.fetch;
  const calls = { resend: [], turnstile: 0 };
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("turnstile")) {
      calls.turnstile += 1;
      return { ok: true, json: async () => ({ success: options.turnstileFails ? false : true }) };
    }
    if (u.includes("api.resend.com")) {
      const index = calls.resend.length;
      calls.resend.push(JSON.parse((opts && opts.body) || "{}"));
      if (options.resend) return options.resend(index);
      return { ok: true, status: 200, json: async () => ({ id: `email_${index}` }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    return await fn(calls);
  } finally {
    global.fetch = original;
  }
}

/** Records console output instead of printing it. */
async function quietly(fn) {
  const originals = {};
  const lines = [];
  for (const level of ["log", "warn", "error"]) {
    originals[level] = console[level];
    console[level] = (...args) => lines.push(args.map(String).join(" "));
  }
  try {
    return { value: await fn(), lines };
  } finally {
    for (const level of Object.keys(originals)) console[level] = originals[level];
  }
}

function post(fields, { ip = freshIp(), origin = SITE } = {}) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return new Request(`${SITE}/api/submit-form`, {
    method: "POST",
    headers: { Origin: origin, "X-Forwarded-For": ip },
    body
  });
}

/** The contact form exactly as contact.html posts it (Formspree field names). */
function contactFields(extra = {}) {
  return {
    _gotcha: "",
    name: "Rowan",
    _replyto: "rowan@example.com",
    message: "Need 50 favors for a wedding.",
    "cf-turnstile-response": "token",
    ...extra
  };
}

/** The review form exactly as reviews.html posts it. */
function reviewFields(extra = {}) {
  return {
    _gotcha: "",
    name: "@goth_grandma",
    email: "grandma@example.com",
    product: "Sleep Salve",
    rating: "5",
    review: "Slept like the dead.",
    "cf-turnstile-response": "token",
    ...extra
  };
}

/* ==========================================================================
   1. The happy path and the order of the two sends
   ========================================================================== */

async function testContactConfirmation(worker, mod) {
  console.log("\n1. contact form: notify the shop, then confirm to the sender");
  const env = await makeEnv();
  await withMocks(async (calls) => {
    const res = await worker.fetch(post(contactFields()), env);
    eq(res.status, 200, "a valid contact message answers 200");
    eq(calls.resend.length, 2, "exactly two emails: the notification and the confirmation");

    const [notice, confirm] = calls.resend;
    eq(notice.to, [SHOP], "the FIRST send goes to the shop");
    eq(
      notice.reply_to,
      "rowan@example.com",
      "the notification's reply_to is the sender (_replyto)"
    );
    assert(
      notice.text.includes("Need 50 favors for a wedding."),
      "the notification carries the message"
    );

    eq(confirm.to, ["rowan@example.com"], "the SECOND send goes to the sender");
    eq(confirm.reply_to, SHOP, "the confirmation's reply_to is the shop mailbox");
    eq(confirm.from, env.FROM_EMAIL, "the confirmation comes from the verified sender");
    eq(confirm.subject, mod.CONFIRMATIONS.contact.subject, "contact confirmation subject");
    eq(confirm.text, mod.CONFIRMATIONS.contact.text, "contact confirmation body is the fixed text");
    assert(!("html" in confirm), "the confirmation is plain text only");
    assert(
      !confirm.text.includes("Rowan") && !confirm.text.includes("favors"),
      "nothing the visitor typed is copied into the confirmation"
    );
  });
}

/* ==========================================================================
   2. Failure ordering
   ========================================================================== */

async function testFailureOrdering(worker) {
  console.log(
    "\n2. a failed notification sends no confirmation; a failed confirmation is not a failure"
  );
  const env = await makeEnv();

  await withMocks(
    async (calls) => {
      const { value: res } = await quietly(() => worker.fetch(post(contactFields()), env));
      eq(res.status, 500, "a refused notification is a failure to the caller");
      eq(calls.resend.length, 1, "and NO confirmation is attempted");
    },
    { resend: () => ({ ok: false, status: 500, json: async () => ({}) }) }
  );

  await withMocks(
    async (calls) => {
      const { value: res } = await quietly(() => worker.fetch(post(contactFields()), env));
      eq(res.status, 500, "a notification that throws is a failure to the caller");
      eq(calls.resend.length, 1, "and NO confirmation is attempted after a throw either");
    },
    {
      resend: () => {
        throw new Error("network down");
      }
    }
  );

  await withMocks(
    async (calls) => {
      const { value: res, lines } = await quietly(() =>
        worker.fetch(post(contactFields({ _replyto: "late@example.com" })), env)
      );
      eq(res.status, 200, "a refused confirmation still answers 200 -- the shop has the message");
      eq(calls.resend.length, 2, "both sends were attempted");
      assert(
        lines.some((l) => l.includes("confirmation was not accepted")),
        "the refused confirmation is logged"
      );
      assert(
        !lines.some((l) => l.includes("late@example.com")),
        "the log line does not carry the address"
      );
    },
    {
      resend: (i) =>
        i === 0
          ? { ok: true, status: 200, json: async () => ({}) }
          : { ok: false, status: 422, json: async () => ({}) }
    }
  );

  await withMocks(
    async (calls) => {
      const { value: res } = await quietly(() =>
        worker.fetch(post(contactFields({ _replyto: "thrown@example.com" })), env)
      );
      eq(res.status, 200, "a confirmation that throws still answers 200");
      eq(calls.resend.length, 2, "both sends were attempted");
    },
    {
      resend: (i) => {
        if (i === 0) return { ok: true, status: 200, json: async () => ({}) };
        throw new Error("network down");
      }
    }
  );
}

/* ==========================================================================
   3. Reviews
   ========================================================================== */

async function testReviews(worker, mod) {
  console.log("\n3. review form: review copy, and no confirmation without an email");
  const env = await makeEnv();

  await withMocks(async (calls) => {
    const res = await worker.fetch(post(reviewFields()), env);
    eq(res.status, 200, "a review with an email answers 200");
    eq(calls.resend.length, 2, "notification and confirmation");
    const [notice, confirm] = calls.resend;
    assert(notice.subject.startsWith("New review from"), "the shop sees it is a review");
    assert(
      notice.text.includes("Product: Sleep Salve") && notice.text.includes("Rating: 5"),
      "the notification carries product and rating"
    );
    eq(confirm.text, mod.CONFIRMATIONS.review.text, "the review confirmation uses the review copy");
    eq(confirm.reply_to, SHOP, "the review confirmation's reply_to is the shop");
  });

  await withMocks(async (calls) => {
    const res = await worker.fetch(post(reviewFields({ email: "" })), env);
    eq(res.status, 200, "a review WITHOUT an email is accepted (reviews.html allows it)");
    eq(calls.resend.length, 1, "and is delivered with no confirmation");
    assert(!("reply_to" in calls.resend[0]), "and no reply_to is invented for it");
  });

  await withMocks(async (calls) => {
    const res = await worker.fetch(post(contactFields({ _replyto: "" })), env);
    eq(res.status, 400, "a contact message WITHOUT an email is still refused");
    eq(calls.resend.length, 0, "and nothing is sent");
  });
}

/* ==========================================================================
   4. Rate limits: per IP and per recipient, through checkRateLimit
   ========================================================================== */

async function testRateLimits(worker, mod) {
  console.log("\n4. rate limits: per client IP and per recipient address");

  const env = await makeEnv();
  const ip = "198.51.100.77";
  await withMocks(async (calls) => {
    const statuses = [];
    for (let i = 0; i < mod.FORM_IP_RATE_LIMIT.limit + 1; i++) {
      const res = await worker.fetch(
        post(contactFields({ _replyto: `p${i}@example.com` }), { ip }),
        env
      );
      statuses.push(res.status);
    }
    eq(
      statuses.slice(0, mod.FORM_IP_RATE_LIMIT.limit).every((s) => s === 200),
      true,
      `the first ${mod.FORM_IP_RATE_LIMIT.limit} from one IP succeed`
    );
    eq(statuses[mod.FORM_IP_RATE_LIMIT.limit], 429, "the next one from that IP is refused");
    eq(
      calls.resend.length,
      mod.FORM_IP_RATE_LIMIT.limit * 2,
      "the refused request sent nothing at all"
    );
  });

  const env2 = await makeEnv();
  await withMocks(async (calls) => {
    const statuses = [];
    for (let i = 0; i < mod.FORM_RECIPIENT_RATE_LIMIT.limit + 1; i++) {
      // A fresh IP each time: only the recipient is shared.
      const res = await worker.fetch(post(contactFields({ _replyto: "Target@Example.com" })), env2);
      statuses.push(res.status);
    }
    eq(
      statuses[mod.FORM_RECIPIENT_RATE_LIMIT.limit],
      429,
      "one address cannot be mailed more than the recipient limit, whatever the IP"
    );
    eq(
      calls.resend.length,
      mod.FORM_RECIPIENT_RATE_LIMIT.limit * 2,
      "the refused request sent neither email"
    );
    const res = await worker.fetch(post(contactFields({ _replyto: "target@example.com" })), env2);
    eq(res.status, 429, "the recipient limit ignores case");

    const names = [...env2.RATE_LIMIT_COUNTER._instances.keys()];
    assert(
      names.some((n) => n.includes("form:to:")),
      "a per-recipient counter exists"
    );
    assert(
      !names.some((n) => n.toLowerCase().includes("target@example.com")),
      "the recipient counter is keyed by a hash, never the raw address"
    );
  });

  const env3 = await makeEnv({ RATE_LIMIT_COUNTER: undefined });
  await withMocks(async (calls) => {
    const res = await worker.fetch(post(contactFields()), env3);
    eq(res.status, 200, "with no limiter bound the form still works (fails open, as restock does)");
    eq(calls.resend.length, 2, "and both emails go out");
  });
}

/* ==========================================================================
   5. Input hygiene and refusals
   ========================================================================== */

async function testHygiene(worker) {
  console.log("\n5. honeypot, configuration, CRLF and header injection");
  const env = await makeEnv();

  await withMocks(async (calls) => {
    const res = await worker.fetch(post(contactFields({ _gotcha: "i am a bot" })), env);
    eq(res.status, 200, "a filled _gotcha honeypot gets the success status");
    eq(calls.resend.length, 0, "and nothing is sent");
    eq(calls.turnstile, 0, "and Turnstile is not even asked");
  });

  await withMocks(
    async (calls) => {
      const res = await worker.fetch(post(contactFields()), env);
      eq(res.status, 400, "a failed Turnstile check is refused");
      eq(calls.resend.length, 0, "and nothing is sent");
    },
    { turnstileFails: true }
  );

  for (const missing of ["RESEND_API_KEY", "TURNSTILE_SECRET_KEY", "TO_EMAIL", "FROM_EMAIL"]) {
    const broken = await makeEnv({ [missing]: "" });
    await withMocks(async (calls) => {
      const { value: res } = await quietly(() => worker.fetch(post(contactFields()), broken));
      eq(res.status, 503, `no ${missing} is a 503, not a cheerful success`);
      eq(calls.resend.length, 0, `and nothing is sent without ${missing}`);
    });
  }

  await withMocks(async (calls) => {
    const res = await worker.fetch(
      post(contactFields({ message: "line one\r\nline two\rline three" })),
      env
    );
    eq(res.status, 200, "a multi-line message is accepted");
    const notice = calls.resend[0];
    assert(!notice.text.includes("\r"), "no carriage return survives into the text body");
    assert(
      notice.text.includes("line one\nline two\nline three"),
      "CRLF and bare CR are normalised to LF"
    );
    assert(notice.html.includes("line one<br>line two"), "the HTML body breaks on the same lines");
  });

  await withMocks(async (calls) => {
    const res = await worker.fetch(
      post(contactFields({ name: "Eve\r\nBcc: victim@example.com <b>" })),
      env
    );
    eq(res.status, 200, "a hostile name is still delivered");
    const notice = calls.resend[0];
    assert(!/[\r\n]/.test(notice.subject), "the subject can never carry a line break");
    assert(notice.html.includes("&lt;b&gt;"), "the name is escaped in the HTML body");
  });
}

/* ==========================================================================
   6. The copy promises only what the site already says
   ========================================================================== */

function testCopyMatchesSite(mod) {
  console.log("\n6. confirmation copy repeats only promises the site makes");
  const flat = (s) => s.replace(/\s+/g, " ");
  const contactPage = flat(fs.readFileSync(path.join(ROOT, "contact.html"), "utf8"));
  const reviewsPage = flat(
    fs.readFileSync(path.join(ROOT, "reviews.html"), "utf8").replace(/&rsquo;|’/g, "'")
  );
  const content = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/content.json"), "utf8"));
  const contactText = flat(mod.CONFIRMATIONS.contact.text);
  const reviewText = flat(mod.CONFIRMATIONS.review.text);

  const contactPromise = "We typically respond within two business days.";
  assert(contactText.includes(contactPromise), "the contact confirmation states the response time");
  assert(contactPage.includes(contactPromise), "...and contact.html makes that exact promise");
  assert(
    JSON.stringify(content).includes(contactPromise),
    "...and content.json (the CMS source) makes it too"
  );

  const reviewPromise =
    "Savanna reads every one before it's posted, so it might take a few days to show up.";
  assert(reviewText.includes(reviewPromise), "the review confirmation states the moderation delay");
  assert(reviewsPage.includes(reviewPromise), "...and reviews.html makes that exact promise");
  assert(
    reviewText.includes("we never publish it"),
    "the review confirmation repeats the privacy note"
  );
  assert(
    reviewsPage.includes("we never publish this"),
    "...which reviews.html makes on the email field"
  );

  for (const [kind, text] of [
    ["contact", contactText],
    ["review", reviewText]
  ]) {
    assert(
      !/\d+\s*(hours?|days?)\b/i.test(text.replace("two business days", "")),
      `${kind}: no other time promise`
    );
    assert(!/discount|code|%|free/i.test(text), `${kind}: no offer the page does not make`);
  }
}

/* ==========================================================================
   Runner
   ========================================================================== */

(async () => {
  const mod = await import("../workers/submit-form.js");
  const worker = mod.default;
  await testContactConfirmation(worker, mod);
  await testFailureOrdering(worker);
  await testReviews(worker, mod);
  await testRateLimits(worker, mod);
  await testHygiene(worker);
  testCopyMatchesSite(mod);

  if (passed === 0) {
    console.error(
      "\nworker-submit-form.test.js: NO assertions ran -- that is a failure, not a pass."
    );
    process.exit(1);
  }
  console.log(`\nworker-submit-form.test.js: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error("worker-submit-form.test.js crashed:", err);
  process.exit(1);
});
