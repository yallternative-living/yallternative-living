/**
 * @fileoverview Unit tests for the MoCRA adverse-event route:
 *   - workers/routes/safety-report.js  (validation, honeypot, rate limit, the
 *                                       server-computed serious flag, the D1
 *                                       row, the two Resend sends, and what is
 *                                       allowed to reach a log line)
 *   - the registration in workers/checkout.js and the schema-version bump in
 *     workers/state/migrations.js
 *
 * Same harness as scripts/worker-retention.test.js: no network, no wrangler. D1
 * is emulated on `node:sqlite` (scripts/lib/d1-emulator.js) and only Resend is
 * mocked, so every assertion here is driven through the REAL entrypoint --
 * workers/checkout.js's default export -- rather than by calling the handler
 * directly. A suite that imported the handler and skipped the router would pass
 * happily on a route nobody had wired up, which is the failure mode AGENTS.md's
 * "checks that stop checking" section is about.
 *
 * Run: node scripts/worker-safety-report.test.js
 */

const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { makeD1, makeNamespace } = require("./lib/d1-emulator.js");

const ROOT = path.join(__dirname, "..");
const SITE = "https://yallternativeliving.com";

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
   Harness
   ========================================================================== */

let ipCounter = 0;

/** A fresh client IP per request, so one test's rate limit is not another's. */
function freshIp() {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
}

async function makeEnv(overrides = {}) {
  const { GiftCardLedger } = await import("../workers/state/gift-card-ledger.js");
  const { RateLimitCounter } = await import("../workers/state/rate-limit.js");
  const { applyMigrations, resetSchemaMemo } = await import("../workers/state/migrations.js");
  resetSchemaMemo();
  const db = makeD1(new DatabaseSync(":memory:"));
  await applyMigrations(db);
  const env = {
    SITE_ORIGIN: SITE,
    RESEND_API_KEY: "re_test_safety",
    MAGIC_LINK_SECRET: "safety-suite-signing-secret",
    STATE_DB: db,
    GIFT_CARD_LEDGER: makeNamespace(GiftCardLedger),
    RATE_LIMIT_COUNTER: makeNamespace(RateLimitCounter),
    ...overrides
  };
  // `undefined` in an override means "unset this binding", which `...overrides`
  // alone does not do for a key the defaults above set.
  Object.keys(overrides).forEach((k) => {
    if (overrides[k] === undefined) delete env[k];
  });
  return env;
}

/** Swap global.fetch for a Resend recorder. Nothing else is reachable. */
async function withResend(fn, options = {}) {
  const originalFetch = global.fetch;
  const calls = { resend: [] };
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("api.resend.com")) {
      calls.resend.push({
        message: JSON.parse((opts && opts.body) || "{}"),
        headers: (opts && opts.headers) || {}
      });
      if (options.resendFails) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ id: "email_1" }) };
    }
    throw new Error(`unexpected fetch to ${u}`);
  };
  try {
    return await fn(calls);
  } finally {
    global.fetch = originalFetch;
  }
}

/**
 * Capture everything the code under test writes to the console, so a test can
 * assert what is NOT in it. Both channels: an accidental console.log of a
 * report body is exactly as bad as a console.error of one.
 */
async function captureLogs(fn) {
  const lines = [];
  const originals = { log: console.log, error: console.error, warn: console.warn };
  const record = (...args) => lines.push(args.map((a) => String(a)).join(" "));
  console.log = record;
  console.error = record;
  console.warn = record;
  try {
    const value = await fn();
    return { value, logs: lines.join("\n") };
  } finally {
    console.log = originals.log;
    console.error = originals.error;
    console.warn = originals.warn;
  }
}

function postJson(body, headers = {}) {
  return new Request(`${SITE}/api/safety-report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: SITE,
      "X-Forwarded-For": freshIp(),
      ...headers
    },
    body: JSON.stringify(body)
  });
}

function postForm(fields, headers = {}) {
  const params = new URLSearchParams();
  Object.keys(fields).forEach((key) => {
    const value = fields[key];
    if (Array.isArray(value)) value.forEach((v) => params.append(key, v));
    else params.append(key, value);
  });
  return new Request(`${SITE}/api/safety-report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: SITE,
      "X-Forwarded-For": freshIp(),
      ...headers
    },
    body: params.toString()
  });
}

const noCtx = { waitUntil: () => {} };

/** A complete, minimal, valid report. Spread and override per test. */
const BASE_REPORT = {
  product_id: "sleep-salve",
  lot: "B-2026-04",
  channel: "site",
  first_use_date: "2026-08-01",
  reaction_date: "2026-08-03",
  body_area: "Left forearm",
  description: "Red itchy patch about the size of a quarter, came up within an hour.",
  outcomes: ["cleared-up"],
  stopped_use: "yes",
  reporter_name: "Dana Reporter",
  email: "Dana@Example.COM",
  reporter_phone: "864-555-0100",
  age_range: "35-44",
  sex: "prefer-not-to-say",
  contact_consent: true
};

async function rowFor(env, reference) {
  return env.STATE_DB.prepare("SELECT * FROM adverse_events WHERE id = ?").bind(reference).first();
}

/* ==========================================================================
   1. The route is actually wired into the Worker
   ========================================================================== */

async function testWiring() {
  console.log("\n1. Registration in workers/checkout.js");
  const workerModule = await import("../workers/checkout.js");
  const worker = workerModule.default || workerModule;
  const { routeOf } = workerModule;

  eq(routeOf("/api/safety-report"), "/safety-report", "the /api prefix is stripped by routeOf");
  eq(routeOf("/safety-report"), "/safety-report", "the Netlify :splat spelling routes too");

  const env = await makeEnv();
  await withResend(async () => {
    const res = await worker.fetch(postJson(BASE_REPORT), env, noCtx);
    assert(res.status === 200, "POST /api/safety-report is a known route (not 404)");
  });

  const getRes = await worker.fetch(
    new Request(`${SITE}/api/safety-report`, { method: "GET", headers: { Origin: SITE } }),
    env,
    noCtx
  );
  eq(getRes.status, 405, "GET is refused: this route is POST-only like every other one");

  const foreign = await withResend(() =>
    worker.fetch(postJson(BASE_REPORT, { Origin: "https://evil.example" }), env, noCtx)
  );
  eq(foreign.status, 403, "a cross-site Origin is refused before the report is read");

  const source = fs.readFileSync(path.join(ROOT, "workers", "checkout.js"), "utf8");
  assert(
    /POST \/api\/safety-report/.test(source),
    "the route is documented in the checkout.js header comment like every other one"
  );
  assert(
    /SAFETY_REPORT_EMAIL/.test(source),
    "SAFETY_REPORT_EMAIL is documented in the checkout.js vars list"
  );
}

/* ==========================================================================
   2. Validation
   ========================================================================== */

async function testValidation() {
  console.log("\n2. Validation and field bounds");
  const workerModule = await import("../workers/checkout.js");
  const worker = workerModule.default || workerModule;
  const env = await makeEnv();

  await withResend(async () => {
    const noEmail = await worker.fetch(postJson({ ...BASE_REPORT, email: "" }), env, noCtx);
    eq(noEmail.status, 400, "a missing email is a 400");
    const body = await noEmail.json();
    assert(/email address/i.test(body.error), "…and the message says which field");

    const badEmail = await worker.fetch(postJson({ ...BASE_REPORT, email: "nope" }), env, noCtx);
    eq(badEmail.status, 400, "a malformed email is a 400");

    const noDesc = await worker.fetch(postJson({ ...BASE_REPORT, description: "  " }), env, noCtx);
    eq(noDesc.status, 400, "a blank description is a 400 -- there is no report without one");

    const badDate = await worker.fetch(
      postJson({ ...BASE_REPORT, reaction_date: "08/03/2026" }),
      env,
      noCtx
    );
    eq(
      badDate.status,
      400,
      "a date that is not YYYY-MM-DD is refused rather than silently dropped"
    );

    const impossible = await worker.fetch(
      postJson({ ...BASE_REPORT, first_use_date: "2026-13-45" }),
      env,
      noCtx
    );
    eq(impossible.status, 400, "…and a well-shaped but impossible date is refused too");

    // Blank dates are fine: the form says so, and a person who cannot remember
    // must still be able to file.
    const noDates = await worker.fetch(
      postJson({ ...BASE_REPORT, first_use_date: "", reaction_date: "" }),
      env,
      noCtx
    );
    eq(noDates.status, 200, "blank dates are accepted -- they are optional on the form");
  });

  // Every bounded field, in one accepted report.
  await withResend(async () => {
    const res = await worker.fetch(
      postJson({
        ...BASE_REPORT,
        description: "x".repeat(9000),
        lot: "L".repeat(200),
        body_area: "B".repeat(500),
        reporter_name: "N".repeat(400),
        reporter_phone: "9".repeat(200),
        product_id: "p".repeat(400),
        channel: "carrier-pigeon",
        age_range: "immortal",
        sex: "unspecified-nonsense",
        stopped_use: "maybe",
        outcomes: ["cleared-up", "not-a-real-outcome", "cleared-up"]
      }),
      env,
      noCtx
    );
    const body = await res.json();
    const row = await rowFor(env, body.reference);
    eq(row.description.length, 5000, "the description is capped at 5000 characters");
    eq(row.lot.length, 60, "the lot is capped at 60");
    eq(row.body_area.length, 200, "the body area is capped at 200");
    eq(row.reporter_name.length, 120, "the reporter name is capped at 120");
    eq(row.reporter_phone.length, 40, "the phone is capped at 40");
    eq(row.product_id.length, 100, "the product id is capped at 100");
    eq(row.channel, "", "a channel outside the allowlist is dropped, not stored");
    eq(row.age_range, "", "an age range outside the allowlist is dropped");
    eq(row.sex, "", "a sex outside the allowlist is dropped");
    eq(row.stopped_use, "", "stopped_use accepts only yes/no");
    eq(
      JSON.parse(row.outcomes),
      ["cleared-up"],
      "unknown outcomes are dropped and duplicates collapse"
    );
  });

  // Control characters must not survive into a subject line or a stored field.
  await withResend(async (calls) => {
    const res = await worker.fetch(
      postJson({
        ...BASE_REPORT,
        reporter_name: "Dana\r\nBcc: someone@evil.example",
        description: "line one\nline two"
      }),
      env,
      noCtx
    );
    const body = await res.json();
    const row = await rowFor(env, body.reference);
    assert(
      !/[\r\n]/.test(row.reporter_name),
      "CR/LF is stripped from single-line fields -- no header injection through the name"
    );
    assert(
      row.description.indexOf("\n") !== -1,
      "…but the description keeps its own line breaks: it is the person's words"
    );
    assert(
      calls.resend.every((c) => !/[\r\n]/.test(c.message.subject)),
      "no subject line carries a newline"
    );
  });

  eq(
    await (async () => {
      const mod = await import("../workers/routes/safety-report.js");
      return mod.normalizeReport({ email: "A@B.co", description: "hi" }, []).reporter_email;
    })(),
    "a@b.co",
    "the email is normalised to lower case before it is stored"
  );
}

/* ==========================================================================
   3. The honeypot
   ========================================================================== */

async function testHoneypot() {
  console.log("\n3. Honeypot");
  const workerModule = await import("../workers/checkout.js");
  const worker = workerModule.default || workerModule;
  const env = await makeEnv();

  /* This route does NOT get the silent honeypot the newsletter routes get.
     It used to: it answered {ok:true, reference:"YL-AE-...."} and the page
     said "Report filed. Thank you ... we've emailed it to you as well" while
     nothing was stored and nothing was sent, so any false positive on the
     hidden field told someone reporting a skin reaction that their MoCRA
     report was on file (live audit M11). It still stores and sends nothing;
     it just stops pretending. */
  await withResend(async (calls) => {
    const res = await worker.fetch(
      postJson({ ...BASE_REPORT, website_hp: "http://spam.example" }),
      env,
      noCtx
    );
    eq(res.status, 200, "a filled honeypot is still accepted with a 200");
    const body = await res.json();
    assert(body.ok === true, "…still the accepted shape");
    eq(body.filed, false, "…but it says plainly that nothing was filed");
    eq(body.reference, undefined, "…and mints no reference number to pretend with");
    assert(
      typeof body.message === "string" && /y\.allternative\.living@gmail\.com/.test(body.message),
      "…and points the reporter at a human instead"
    );
    assert(
      !/filed|logged|emailed it to you/i.test(body.message),
      "…without claiming the report was filed or emailed"
    );
    eq(calls.resend.length, 0, "nothing is emailed for a honeypot hit");
    const stored = await env.STATE_DB.prepare("SELECT COUNT(*) AS n FROM adverse_events").first();
    eq(stored.n, 0, "and nothing is written to adverse_events");
  });

  /* The no-JS form post has to say the same thing. It used to 303 to
     #safetySuccess, i.e. the "Report filed. Thank you." panel. */
  await withResend(async () => {
    const res = await worker.fetch(
      new Request("https://yallternativeliving.com/api/safety-report", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...BASE_REPORT,
          website_hp: "http://spam.example"
        }).toString()
      }),
      env,
      noCtx
    );
    eq(res.status, 303, "the no-JS honeypot post still redirects back to the page");
    const location = res.headers.get("Location") || "";
    assert(
      location.includes("report=email-us") && location.endsWith("#safetyEmailUs"),
      `no-JS honeypot lands on the "email us" panel, not the receipt (got ${location})`
    );
    assert(
      !location.includes("safetySuccess") && !location.includes("ref="),
      "no-JS honeypot carries no reference and never targets the success panel"
    );
  });
}

/* ==========================================================================
   4. Rate limit
   ========================================================================== */

async function testRateLimit() {
  console.log("\n4. Rate limit");
  const workerModule = await import("../workers/checkout.js");
  const worker = workerModule.default || workerModule;
  const { SAFETY_REPORT_RATE_LIMIT } = await import("../workers/routes/safety-report.js");
  const env = await makeEnv();

  eq(SAFETY_REPORT_RATE_LIMIT, { limit: 5, period: 60 }, "5 reports a minute per IP, like restock");

  await withResend(async () => {
    const ip = "203.0.113.77"; // one bucket for the whole burst
    const statuses = [];
    for (let i = 0; i < SAFETY_REPORT_RATE_LIMIT.limit + 2; i++) {
      const res = await worker.fetch(postJson(BASE_REPORT, { "X-Forwarded-For": ip }), env, noCtx);
      statuses.push(res.status);
    }
    eq(
      statuses.slice(0, SAFETY_REPORT_RATE_LIMIT.limit),
      new Array(SAFETY_REPORT_RATE_LIMIT.limit).fill(200),
      "the first 5 from one IP are accepted"
    );
    assert(
      statuses.slice(SAFETY_REPORT_RATE_LIMIT.limit).every((s) => s === 429),
      "the 6th and 7th are 429"
    );
    const stored = await env.STATE_DB.prepare("SELECT COUNT(*) AS n FROM adverse_events").first();
    eq(stored.n, SAFETY_REPORT_RATE_LIMIT.limit, "a throttled request writes no row");
  });
}

/* ==========================================================================
   5. The serious flag -- computed on the server, never taken from the client
   ========================================================================== */

async function testSeriousFlag() {
  console.log("\n5. The serious flag");
  const workerModule = await import("../workers/checkout.js");
  const worker = workerModule.default || workerModule;
  const mod = await import("../workers/routes/safety-report.js");

  eq(
    mod.SERIOUS_OUTCOMES,
    [
      "death",
      "life-threatening",
      "hospitalization",
      "disability",
      "congenital-anomaly",
      "infection",
      "disfigurement",
      "intervention"
    ],
    "the eight MoCRA serious-event outcomes, and only those eight"
  );
  assert(
    mod.OTHER_OUTCOMES.every((o) => mod.SERIOUS_OUTCOMES.indexOf(o) === -1),
    "the non-serious outcomes do not overlap the serious ones"
  );

  // Each serious outcome sets the flag on its own.
  for (const outcome of mod.SERIOUS_OUTCOMES) {
    const env = await makeEnv();
    // eslint-disable-next-line no-await-in-loop
    await withResend(async (calls) => {
      const res = await worker.fetch(postJson({ ...BASE_REPORT, outcomes: [outcome] }), env, noCtx);
      const body = await res.json();
      const row = await rowFor(env, body.reference);
      eq(row.serious, 1, `"${outcome}" alone makes the report serious`);
      const owner = calls.resend[0];
      assert(
        owner.message.subject.startsWith("SERIOUS -- "),
        `…and the owner's subject is prefixed for "${outcome}"`
      );
      assert(
        /15 BUSINESS DAYS/.test(owner.message.text) && /3500A/.test(owner.message.text),
        `…and names the FDA clock and the MedWatch 3500A form for "${outcome}"`
      );
    });
  }

  // The non-serious ones do not.
  const env = await makeEnv();
  await withResend(async (calls) => {
    const res = await worker.fetch(
      postJson({ ...BASE_REPORT, outcomes: ["doctor-visit", "otc-product", "cleared-up"] }),
      env,
      noCtx
    );
    const body = await res.json();
    const row = await rowFor(env, body.reference);
    eq(row.serious, 0, "a doctor visit and an over-the-counter product are not, alone, serious");
    assert(
      !calls.resend[0].message.subject.startsWith("SERIOUS"),
      "…so the subject carries no SERIOUS prefix"
    );
  });

  // A client cannot set the flag, and cannot clear one it earned.
  const env2 = await makeEnv();
  await withResend(async () => {
    const lying = await worker.fetch(
      postJson({ ...BASE_REPORT, outcomes: ["cleared-up"], serious: true }),
      env2,
      noCtx
    );
    const row = await rowFor(env2, (await lying.json()).reference);
    eq(row.serious, 0, "a client-supplied `serious: true` changes nothing");

    const hiding = await worker.fetch(
      postJson({ ...BASE_REPORT, outcomes: ["hospitalization"], serious: false }),
      env2,
      noCtx
    );
    const row2 = await rowFor(env2, (await hiding.json()).reference);
    eq(row2.serious, 1, "…and a client-supplied `serious: false` cannot hide a real one");
  });
}

/* ==========================================================================
   6. The D1 row
   ========================================================================== */

async function testStorage() {
  console.log("\n6. The adverse_events row");
  const workerModule = await import("../workers/checkout.js");
  const worker = workerModule.default || workerModule;
  const env = await makeEnv();

  const before = Date.now();
  const body = await withResend(async () => {
    const res = await worker.fetch(postJson(BASE_REPORT), env, noCtx);
    eq(res.status, 200, "a good report is a 200");
    eq(res.headers.get("Cache-Control"), "no-store", "…answered no-store like every other route");
    return res.json();
  });

  assert(body.ok === true, "the response is { ok: true, reference }");
  assert(
    /^YL-AE-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(body.reference),
    "the reference is YL-AE-XXXX-XXXX over the Crockford alphabet (no I, L, O or U)"
  );

  const row = await rowFor(env, body.reference);
  assert(row, "the row is stored under the reference");
  eq(row.product_id, "sleep-salve", "product_id is stored");
  eq(row.lot, "B-2026-04", "lot is stored");
  eq(row.channel, "site", "channel is stored");
  eq(row.first_use_date, "2026-08-01", "first_use_date is stored");
  eq(row.reaction_date, "2026-08-03", "reaction_date is stored");
  eq(row.body_area, "Left forearm", "body_area is stored");
  eq(row.description, BASE_REPORT.description, "the description is stored verbatim");
  eq(JSON.parse(row.outcomes), ["cleared-up"], "outcomes are stored as a JSON array");
  eq(row.stopped_use, "yes", "stopped_use is stored");
  eq(row.reporter_name, "Dana Reporter", "reporter_name is stored");
  eq(row.reporter_email, "dana@example.com", "reporter_email is stored normalised");
  eq(row.reporter_phone, "864-555-0100", "reporter_phone is stored");
  eq(row.age_range, "35-44", "age_range is stored");
  eq(row.sex, "prefer-not-to-say", "sex is stored");
  eq(row.contact_consent, 1, "contact_consent is stored as 1");
  eq(row.serious, 0, "serious is stored");
  eq(row.status, "new", 'status starts at "new"');
  assert(row.created_at >= before && row.created_at <= Date.now(), "created_at is epoch ms, now");

  assert(
    typeof row.ip_hash === "string" && /^[a-f0-9]{32}$/.test(row.ip_hash),
    "ip_hash is a 32-char hex digest"
  );
  assert(
    row.ip_hash.indexOf("198.51") === -1 && row.ip_hash.indexOf("100.") === -1,
    "THE RAW IP IS NOT STORED -- only the digest"
  );

  // The columns the table has, and no stray one it does not.
  const columns = env.STATE_DB.prepare("SELECT * FROM adverse_events LIMIT 1");
  assert(columns, "adverse_events is queryable");
  const anyRow = await rowFor(env, body.reference);
  assert(
    !Object.prototype.hasOwnProperty.call(anyRow, "ip"),
    "there is no raw-IP column to accidentally fill later"
  );

  // Two reports do not collide, and the second is a separate row.
  await withResend(async () => {
    const second = await worker.fetch(postJson(BASE_REPORT), env, noCtx);
    const secondBody = await second.json();
    assert(secondBody.reference !== body.reference, "each report gets its own reference");
    const count = await env.STATE_DB.prepare("SELECT COUNT(*) AS n FROM adverse_events").first();
    eq(count.n, 2, "…and its own row");
  });
}

/* ==========================================================================
   7. No STATE_DB -- refuse, do not pretend
   ========================================================================== */

async function testNoDatabase() {
  console.log("\n7. Without STATE_DB");
  const workerModule = await import("../workers/checkout.js");
  const worker = workerModule.default || workerModule;
  const env = await makeEnv({ STATE_DB: undefined });

  await withResend(async (calls) => {
    const { value: res } = await captureLogs(() => worker.fetch(postJson(BASE_REPORT), env, noCtx));
    eq(res.status, 503, "no database is a 503, NOT a cheerful success");
    const body = await res.json();
    assert(!body.ok, "…with no ok flag");
    assert(
      /contact@yallternativeliving\.com/.test(body.error),
      "…and an address the reporter can fall back to, so the report is not lost"
    );
    eq(calls.resend.length, 0, "nothing is emailed when nothing was stored");
  });
}

/* ==========================================================================
   8. The two emails
   ========================================================================== */

async function testEmails() {
  console.log("\n8. Resend");
  const workerModule = await import("../workers/checkout.js");
  const worker = workerModule.default || workerModule;

  // Default recipient chain.
  let env = await makeEnv();
  await withResend(async (calls) => {
    const res = await worker.fetch(postJson(BASE_REPORT), env, noCtx);
    const { reference } = await res.json();
    eq(calls.resend.length, 2, "one email to the owner, one to the reporter");

    const owner = calls.resend[0].message;
    const ack = calls.resend[1].message;

    eq(
      owner.to,
      "contact@yallternativeliving.com",
      "with nothing set, the owner copy goes to the default"
    );
    eq(owner.subject, `Reaction report ${reference}`, "the owner subject carries the reference");
    eq(owner.reply_to, "dana@example.com", "replying to the owner copy reaches the reporter");
    assert(
      owner.text.indexOf(BASE_REPORT.description) !== -1,
      "the owner copy carries the description"
    );
    assert(owner.text.indexOf("864-555-0100") !== -1, "…and the phone number");
    assert(/at least 3 years/.test(owner.text), "…and the three-year retention reminder");
    assert(
      /Idempotency-Key/i.test(Object.keys(calls.resend[0].headers).join(",")),
      "the owner copy is sent with an idempotency key"
    );

    eq(ack.to, "dana@example.com", "the acknowledgement goes to the reporter");
    assert(ack.subject.indexOf(reference) !== -1, "…with the reference in the subject");
    assert(ack.text.indexOf(reference) !== -1, "…and in the body");
    assert(
      ack.text.indexOf(BASE_REPORT.description) === -1,
      "the acknowledgement does not echo the report back"
    );
    assert(
      !/treat|cure|heal/i.test(ack.text),
      "the acknowledgement makes no drug claim -- no treat/cure/heal anywhere in it"
    );
  });

  // SAFETY_REPORT_EMAIL wins; RESTOCK_NOTIFY_EMAIL is the fallback.
  env = await makeEnv({
    SAFETY_REPORT_EMAIL: "safety@example.com",
    RESTOCK_NOTIFY_EMAIL: "restock@example.com"
  });
  await withResend(async (calls) => {
    await worker.fetch(postJson(BASE_REPORT), env, noCtx);
    eq(calls.resend[0].message.to, "safety@example.com", "SAFETY_REPORT_EMAIL takes precedence");
  });

  env = await makeEnv({ RESTOCK_NOTIFY_EMAIL: "restock@example.com" });
  await withResend(async (calls) => {
    await worker.fetch(postJson(BASE_REPORT), env, noCtx);
    eq(
      calls.resend[0].message.to,
      "restock@example.com",
      "…and RESTOCK_NOTIFY_EMAIL is the fallback when it is unset"
    );
  });

  // The from-address follows the existing var pattern.
  env = await makeEnv({ GIFT_CARD_FROM_EMAIL: "Y'all <sender@example.com>" });
  await withResend(async (calls) => {
    await worker.fetch(postJson(BASE_REPORT), env, noCtx);
    eq(
      calls.resend[0].message.from,
      "Y'all <sender@example.com>",
      "the From follows the existing GIFT_CARD_FROM_EMAIL pattern"
    );
  });

  // Resend refusing does not un-file a report.
  env = await makeEnv();
  await withResend(
    async () => {
      const { value: res, logs } = await captureLogs(() =>
        worker.fetch(postJson(BASE_REPORT), env, noCtx)
      );
      eq(res.status, 200, "a Resend refusal still returns 200 -- the D1 row IS the record");
      const body = await res.json();
      const row = await rowFor(env, body.reference);
      assert(row, "…and the row is there");
      assert(logs.indexOf(body.reference) !== -1, "…and the failure is logged by reference");
    },
    { resendFails: true }
  );

  // No key at all: still stored, still referenced, loudly logged.
  env = await makeEnv({ RESEND_API_KEY: undefined });
  await withResend(async (calls) => {
    const { value: res, logs } = await captureLogs(() =>
      worker.fetch(postJson(BASE_REPORT), env, noCtx)
    );
    eq(res.status, 200, "a missing RESEND_API_KEY does not lose the report");
    const body = await res.json();
    assert(await rowFor(env, body.reference), "…the row is written");
    eq(calls.resend.length, 0, "…no email is attempted");
    assert(/RESEND_API_KEY is unset/.test(logs), "…and the gap is logged for the operator");
  });
}

/* ==========================================================================
   9. Nothing personal reaches a log line
   ========================================================================== */

async function testLogsCarryNoPii() {
  console.log("\n9. Logging");
  const workerModule = await import("../workers/checkout.js");
  const worker = workerModule.default || workerModule;

  const SECRETS = [
    BASE_REPORT.description,
    "Red itchy patch",
    "dana@example.com",
    "Dana@Example.COM",
    "Dana Reporter",
    "864-555-0100",
    "Left forearm",
    "B-2026-04"
  ];

  // Every path that logs at all: the happy one, a Resend refusal, a missing
  // key, a missing database, and a D1 write that throws.
  const scenarios = [
    ["a successful report", async () => ({ env: await makeEnv(), options: {} })],
    ["a Resend refusal", async () => ({ env: await makeEnv(), options: { resendFails: true } })],
    [
      "no RESEND_API_KEY",
      async () => ({ env: await makeEnv({ RESEND_API_KEY: undefined }), options: {} })
    ],
    ["no STATE_DB", async () => ({ env: await makeEnv({ STATE_DB: undefined }), options: {} })],
    [
      "a D1 write that throws",
      async () => {
        const env = await makeEnv();
        const realPrepare = env.STATE_DB.prepare.bind(env.STATE_DB);
        env.STATE_DB.prepare = (sql) => {
          if (/INSERT INTO adverse_events/.test(sql)) {
            throw new Error("D1_ERROR: no such table: adverse_events");
          }
          return realPrepare(sql);
        };
        return { env, options: {} };
      }
    ]
  ];

  for (const [label, build] of scenarios) {
    // eslint-disable-next-line no-await-in-loop
    const { env, options } = await build();
    // eslint-disable-next-line no-await-in-loop
    const logs = await withResend(
      async () => (await captureLogs(() => worker.fetch(postJson(BASE_REPORT), env, noCtx))).logs,
      options
    );
    const leaked = SECRETS.filter((needle) => logs.indexOf(needle) !== -1);
    eq(leaked, [], `${label}: no description, name, address, phone or lot in the logs`);
  }
}

/* ==========================================================================
   10. The plain form post (JavaScript off)
   ========================================================================== */

async function testFormPost() {
  console.log("\n10. The no-JavaScript form post");
  const workerModule = await import("../workers/checkout.js");
  const worker = workerModule.default || workerModule;
  const env = await makeEnv();

  await withResend(async () => {
    const res = await worker.fetch(
      postForm({
        email: "dana@example.com",
        description: "It stung and went red.",
        outcomes: ["doctor-visit", "hospitalization"],
        contact_consent: "yes",
        stopped_use: "yes"
      }),
      env,
      noCtx
    );
    eq(res.status, 303, "a form post is answered with a redirect, not JSON");
    const location = res.headers.get("Location");
    assert(
      location.indexOf(`${SITE}/safety.html?report=received&ref=YL-AE-`) === 0,
      "…back to safety.html with the reference in the query string"
    );
    const reference = new URL(location).searchParams.get("ref");
    const row = await rowFor(env, reference);
    assert(row, "…and the report really was stored");
    eq(row.serious, 1, "repeated checkboxes arrive as a list, so the serious one is seen");
    eq(JSON.parse(row.outcomes).length, 2, "…both of them");
    eq(row.contact_consent, 1, 'an HTML checkbox value ("yes") reads as consent');
    assert(
      location.indexOf("dana@example.com") === -1 && location.indexOf("stung") === -1,
      "NOTHING PERSONAL IS PUT IN THE REDIRECT URL -- only the opaque reference"
    );
  });

  await withResend(async () => {
    const res = await worker.fetch(postForm({ email: "", description: "" }), env, noCtx);
    eq(res.status, 303, "an invalid form post also redirects rather than showing raw JSON");
    eq(
      res.headers.get("Location"),
      `${SITE}/safety.html?report=error#reaction-report`,
      "…to the error state, with no field values in the URL"
    );
  });
}

/* ==========================================================================
   11. Schema
   ========================================================================== */

async function testSchema() {
  console.log("\n11. Schema version 3");
  const { SCHEMA_VERSION, SCHEMA_STATEMENTS } = await import("../workers/state/migrations.js");
  eq(SCHEMA_VERSION >= 3, true, "the schema version was bumped for adverse_events");

  const { RECORD_RETENTION_YEARS } = await import("../workers/routes/safety-report.js");
  eq(
    RECORD_RETENTION_YEARS,
    3,
    "retention is 3 years -- MoCRA's small-business period (section 612, under $1M average sales)"
  );
  assert(
    SCHEMA_STATEMENTS.some((s) => /CREATE TABLE IF NOT EXISTS adverse_events/.test(s)),
    "migrations.js creates adverse_events"
  );
  const sql = fs.readFileSync(path.join(ROOT, "workers", "schema.sql"), "utf8");
  assert(/CREATE TABLE IF NOT EXISTS adverse_events/.test(sql), "…and so does workers/schema.sql");
  assert(/THREE YEARS/i.test(sql), "…and schema.sql says how long the rows are kept");

  // The cron sweeps three tables. This must never become four.
  const checkout = fs.readFileSync(path.join(ROOT, "workers", "checkout.js"), "utf8");
  const scheduled = checkout.slice(checkout.indexOf("async scheduled("));
  assert(
    scheduled.indexOf("adverse_events") === -1,
    "the cron does not sweep adverse_events -- retention is a minimum, never a purge"
  );
}

/* ==========================================================================
   Run
   ========================================================================== */

(async function run() {
  console.log("workers/routes/safety-report.js -- MoCRA adverse-event intake");
  await testWiring();
  await testValidation();
  await testHoneypot();
  await testRateLimit();
  await testSeriousFlag();
  await testStorage();
  await testNoDatabase();
  await testEmails();
  await testLogsCarryNoPii();
  await testFormPost();
  await testSchema();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (!passed) {
    console.error("No assertions ran at all -- that is a failure, not a pass.");
    process.exit(1);
  }
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
