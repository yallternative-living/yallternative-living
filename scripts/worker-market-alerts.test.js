/**
 * @fileoverview Unit tests for the market-date alerts:
 *   - workers/routes/market-alerts.js  (POST /api/market-alerts: the JSON fetch
 *                                       and the plain form post, the honeypot,
 *                                       the rate limit, the 303 round trip;
 *                                       runMarketReminders: every gate, the
 *                                       sends, the budget, and what is allowed
 *                                       to reach a log line)
 *
 * Node only, no network, no wrangler. D1 is the `node:sqlite` emulator
 * (scripts/lib/d1-emulator.js) with the real migrations applied, wrapped in a
 * recorder so a test can assert WHICH statement ran and with what bind values
 * (INSERT OR IGNORE, the consent sentence). content.json, events.json and
 * Resend are served by one `global.fetch` stub, the same way the site-data
 * helpers reach them in production. The route is driven through the REAL
 * entrypoint -- workers/checkout.js's default export -- so the router wiring is
 * part of what is under test; the cron job is called on the module it lives in
 * with an explicit `now`, because the `scheduled` handler is covered elsewhere.
 *
 * Run: node scripts/worker-market-alerts.test.js
 */

const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { makeD1, makeNamespace } = require("./lib/d1-emulator.js");

const ROOT = path.join(__dirname, "..");

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
    console.log(
      `  ✗ ${desc}\n    ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n    ") : e}`
    );
  }
}

/* ==========================================================================
   Fixtures and harness
   ========================================================================== */

const SITE = "https://yallternativeliving.com";
const SECRET = "market-alerts-suite-signing-secret";
const noCtx = { waitUntil: () => {} };

/** 2026-09-01 12:00 America/New_York (EDT, UTC-4): past the 9am gate. */
const NOON_NY = Date.UTC(2026, 8, 1, 16, 0, 0);
/** 2026-09-01 05:00 America/New_York: before it. */
const DAWN_NY = Date.UTC(2026, 8, 1, 9, 0, 0);
const TODAY = "2026-09-01";
const TOMORROW = "2026-09-02";

/** Two markets tomorrow -- one spelled as a full ISO instant, one as a bare day -- and one later. */
const EVENTS = {
  upcoming: [
    {
      id: "wed-market",
      date: "2026-09-02T09:00:00-04:00",
      dateLabel: "September 2, 2026",
      name: "Landrum Wednesday Market",
      location: "Landrum, SC"
    },
    {
      id: "bare-day-market",
      date: "2026-09-02",
      dateLabel: "September 2, 2026",
      name: "Tryon Bare-Date Market",
      location: "Tryon, NC"
    },
    { id: "later-market", date: "2026-09-05T09:00:00-04:00", name: "Later Market" }
  ],
  past: [{ id: "gone", date: "2026-08-29", name: "Gone Market" }]
};

const INTRO = "Quick reminder that we'll have a table tomorrow. Come say hey.";
const CONTENT = {
  site: {
    enableMarketReminders: true,
    automations: { marketReminderHour: 9, marketReminderIntro: INTRO }
  }
};

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * Wrap a D1 binding so every prepared statement and its bind values are kept.
 * The emulator's `bind()` returns a fresh statement, so the params are recorded
 * on the entry the `prepare()` created.
 */
function recordingD1(db) {
  const statements = [];
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = realPrepare(sql);
    const entry = { sql, params: [] };
    statements.push(entry);
    const realBind = stmt.bind.bind(stmt);
    stmt.bind = (...params) => {
      entry.params = params;
      return realBind(...params);
    };
    return stmt;
  };
  db._statements = statements;
  return db;
}

async function makeEnv(overrides = {}) {
  const { RateLimitCounter } = await import("../workers/state/rate-limit.js");
  const { applyMigrations, resetSchemaMemo } = await import("../workers/state/migrations.js");
  resetSchemaMemo();
  const db = recordingD1(makeD1(new DatabaseSync(":memory:")));
  await applyMigrations(db);
  const env = {
    SITE_ORIGIN: SITE,
    RESEND_API_KEY: "re_test_market",
    MAGIC_LINK_SECRET: SECRET,
    STATE_DB: db,
    RATE_LIMIT_COUNTER: makeNamespace(RateLimitCounter),
    ...overrides
  };
  // `undefined` in an override means "unset this binding".
  Object.keys(overrides).forEach((k) => {
    if (overrides[k] === undefined) delete env[k];
  });
  return env;
}

/**
 * Swap global.fetch for a recorder answering content.json, events.json and
 * Resend. `options.refuse(message)` makes Resend answer 500 for that message.
 */
async function withMocks(fn, options = {}) {
  const original = global.fetch;
  const calls = { resend: [] };
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("content.json")) {
      return { ok: true, status: 200, json: async () => options.content || CONTENT };
    }
    if (u.includes("events.json")) {
      return { ok: true, status: 200, json: async () => options.events || EVENTS };
    }
    if (u.includes("api.resend.com")) {
      const message = JSON.parse((init && init.body) || "{}");
      calls.resend.push({ message, headers: (init && init.headers) || {} });
      if (options.refuse && options.refuse(message)) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ id: `email_${calls.resend.length}` }) };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    return await fn(calls);
  } finally {
    global.fetch = original;
  }
}

/** Capture every console channel so a test can assert what is NOT in it. */
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

let ipCounter = 0;
function freshIp() {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
}

function postJson(body, headers = {}) {
  return new Request(`${SITE}/api/market-alerts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: SITE,
      "X-Forwarded-For": freshIp(),
      ...headers
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

function postForm(fields, headers = {}) {
  return new Request(`${SITE}/api/market-alerts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: SITE,
      "X-Forwarded-For": freshIp(),
      ...headers
    },
    body: new URLSearchParams(fields).toString()
  });
}

function subscribers(env) {
  return env.STATE_DB._raw
    .prepare(
      "SELECT email, created_at, consent_text, last_event_id, last_sent_at " +
        "FROM market_alert_subscribers ORDER BY created_at, email"
    )
    .all();
}

function subscribe(env, email, createdAt, consentText) {
  env.STATE_DB._raw
    .prepare(
      "INSERT INTO market_alert_subscribers (email, created_at, consent_text) VALUES (?, ?, ?)"
    )
    .run(email, createdAt, consentText);
}

/* ========================================================================== */

(async () => {
  const mod = await import("../workers/routes/market-alerts.js");
  const state = await import("../workers/state/job-state.js");
  const retention = await import("../workers/state/retention.js");
  const worker = (await import("../workers/checkout.js")).default;
  const { CONSENT_TEXT, MARKET_REMINDER_JOB, MARKET_REMINDER_BATCH } = mod;

  /* ================================================ the consent sentence */
  console.log("\n--- the consent sentence ---");
  await it("CONSENT_TEXT is the exact sentence assets/js/main.js renders under the input", () => {
    const src = fs.readFileSync(path.join(ROOT, "assets/js/main.js"), "utf8");
    const match = /var MARKET_ALERT_CONSENT = "([^"]+)";/.exec(src);
    assert.ok(match, "main.js declares MARKET_ALERT_CONSENT");
    assert.equal(match[1], CONSENT_TEXT);
    assert.ok(src.includes('name="website_hp"'), "the form carries the website_hp honeypot");
    assert.ok(src.includes('action="/api/market-alerts"'), "and posts to /api/market-alerts");
  });

  /* ================================================ POST /api/market-alerts */
  console.log("\n--- POST /api/market-alerts (JSON) ---");
  await it("stores a JSON signup lower-cased, with the exact consent sentence, via INSERT OR IGNORE", async () => {
    const env = await makeEnv();
    const before = Date.now();
    const res = await withMocks(() =>
      worker.fetch(postJson({ email: "  Shopper@Example.COM " }), env, noCtx)
    );
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.ok(typeof body.message === "string" && /day before/.test(body.message));
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), SITE);

    const rows = subscribers(env);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, "shopper@example.com");
    assert.equal(rows[0].consent_text, CONSENT_TEXT);
    assert.ok(rows[0].created_at >= before && rows[0].created_at <= Date.now());
    assert.equal(rows[0].last_event_id, null);
    assert.equal(rows[0].last_sent_at, null);

    const insert = env.STATE_DB._statements.find((s) =>
      /INTO market_alert_subscribers/.test(s.sql)
    );
    assert.ok(insert, "the row went through a prepared statement");
    assert.match(insert.sql, /INSERT OR IGNORE INTO market_alert_subscribers/);
    assert.equal(insert.params[0], "shopper@example.com");
    assert.equal(insert.params[2], CONSENT_TEXT);
  });

  await it("a repeat signup is idempotent and still reports ok", async () => {
    const env = await makeEnv();
    await withMocks(async () => {
      const first = await worker.fetch(postJson({ email: "again@example.com" }), env, noCtx);
      assert.equal(first.status, 200);
      const firstRow = subscribers(env)[0];
      const second = await worker.fetch(postJson({ email: "AGAIN@example.com" }), env, noCtx);
      assert.equal(second.status, 200);
      assert.equal((await second.json()).ok, true);
      const rows = subscribers(env);
      assert.equal(rows.length, 1, "one row, not two");
      assert.equal(rows[0].created_at, firstRow.created_at, "the original signup time is kept");
      assert.equal(rows[0].consent_text, CONSENT_TEXT);
      const inserts = env.STATE_DB._statements.filter((s) =>
        /INTO market_alert_subscribers/.test(s.sql)
      );
      assert.equal(inserts.length, 2);
      assert.ok(inserts.every((s) => /INSERT OR IGNORE/.test(s.sql)));
    });
  });

  await it("an invalid or missing address is a 400 and stores nothing", async () => {
    const env = await makeEnv();
    await withMocks(async () => {
      for (const body of [{ email: "nope" }, { email: "" }, {}, { email: 42 }, { email: "a@b" }]) {
        const res = await worker.fetch(postJson(body), env, noCtx);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.match((await res.json()).error, /valid email/);
      }
      const malformed = await worker.fetch(postJson("{not json"), env, noCtx);
      assert.equal(malformed.status, 400, "a malformed JSON body is a 400, not a 500");
    });
    assert.equal(subscribers(env).length, 0);
  });

  await it("the honeypot (website_hp or events_alert_website) answers ok and stores nothing", async () => {
    const env = await makeEnv();
    await withMocks(async (calls) => {
      for (const body of [
        { email: "bot@example.com", website_hp: "http://spam.example" },
        { email: "bot2@example.com", events_alert_website: "x" }
      ]) {
        const res = await worker.fetch(postJson(body), env, noCtx);
        assert.equal(res.status, 200);
        assert.equal((await res.json()).ok, true, "the same success shape a person gets");
      }
      assert.equal(calls.resend.length, 0);
    });
    assert.equal(subscribers(env).length, 0, "the honeypot must not fill the alert list");
  });

  await it("the sixth signup from one IP inside a minute is a 429", async () => {
    const env = await makeEnv();
    const ip = "203.0.113.77";
    await withMocks(async () => {
      for (let i = 0; i < mod.MARKET_ALERT_RATE_LIMIT.limit; i++) {
        const res = await worker.fetch(
          postJson({ email: `person${i}@example.com` }, { "X-Forwarded-For": ip }),
          env,
          noCtx
        );
        assert.equal(res.status, 200, `signup ${i + 1} is allowed`);
      }
      const res = await worker.fetch(
        postJson({ email: "sixth@example.com" }, { "X-Forwarded-For": ip }),
        env,
        noCtx
      );
      assert.equal(res.status, 429);
      assert.match((await res.json()).error, /Too many/);
      const other = await worker.fetch(postJson({ email: "sixth@example.com" }), env, noCtx);
      assert.equal(other.status, 200, "a different IP is not in that bucket");
    });
    assert.equal(subscribers(env).length, mod.MARKET_ALERT_RATE_LIMIT.limit + 1);
  });

  await it("with no STATE_DB it answers 503 rather than pretending, and logs no address", async () => {
    const env = await makeEnv({ STATE_DB: undefined });
    const { value: res, logs } = await withMocks(() =>
      captureLogs(() => worker.fetch(postJson({ email: "lost@example.com" }), env, noCtx))
    );
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /unavailable/);
    assert.match(logs, /STATE_DB/);
    assert.ok(!logs.includes("lost@example.com"), "no address in the log");
  });

  await it("a D1 failure is a 502 with the SQLite message logged and never the address", async () => {
    const env = await makeEnv();
    const realPrepare = env.STATE_DB.prepare.bind(env.STATE_DB);
    env.STATE_DB.prepare = (sql) => {
      if (/INTO market_alert_subscribers/.test(sql)) {
        throw new Error("D1_ERROR: no such table: market_alert_subscribers");
      }
      return realPrepare(sql);
    };
    const { value: res, logs } = await withMocks(() =>
      captureLogs(() => worker.fetch(postJson({ email: "unlucky@example.com" }), env, noCtx))
    );
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /could not save/);
    assert.match(logs, /D1_ERROR/);
    assert.ok(!logs.includes("unlucky@example.com"), "no address in the log");
  });

  console.log("\n--- POST /api/market-alerts (the no-JavaScript form post) ---");
  const SAVED = `${SITE}/events.html?market-alerts=saved#eventsMarketAlertTitle`;
  const ERROR = `${SITE}/events.html?market-alerts=error#eventsMarketAlertTitle`;

  await it("a form-encoded signup is stored lower-cased and answered with a 303 to ?market-alerts=saved", async () => {
    const env = await makeEnv();
    const res = await withMocks(() =>
      worker.fetch(postForm({ email: "Form.Visitor@Example.com", website_hp: "" }), env, noCtx)
    );
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), SAVED);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.ok(!/@|form\.visitor/i.test(res.headers.get("Location")), "no address in the URL");
    const rows = subscribers(env);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, "form.visitor@example.com");
    assert.equal(rows[0].consent_text, CONSENT_TEXT);
  });

  await it("a failing form post is a 303 to ?market-alerts=error, still with no address in the URL", async () => {
    const env = await makeEnv();
    await withMocks(async () => {
      const bad = await worker.fetch(postForm({ email: "not-an-address" }), env, noCtx);
      assert.equal(bad.status, 303);
      assert.equal(bad.headers.get("Location"), ERROR);

      const dbless = await makeEnv({ STATE_DB: undefined });
      const { value: gone } = await captureLogs(() =>
        worker.fetch(postForm({ email: "person@example.com" }), dbless, noCtx)
      );
      assert.equal(gone.status, 303, "a 503 becomes the error redirect for a form");
      assert.equal(gone.headers.get("Location"), ERROR);
      assert.ok(!gone.headers.get("Location").includes("person"), "no address in the URL");
    });
    assert.equal(subscribers(env).length, 0);
  });

  await it("the form honeypot is a 303 to saved that stores nothing", async () => {
    const env = await makeEnv();
    await withMocks(async () => {
      for (const fields of [
        { email: "bot@example.com", website_hp: "spam" },
        { email: "bot@example.com", events_alert_website: "spam" }
      ]) {
        const res = await worker.fetch(postForm(fields), env, noCtx);
        assert.equal(res.status, 303);
        assert.equal(res.headers.get("Location"), SAVED);
      }
    });
    assert.equal(subscribers(env).length, 0);
  });

  /* ======================================================= date helpers */
  console.log("\n--- addDays / eventStartDay / eventsStartingOn ---");
  await it("addDays crosses a month, a year, February and both DST changes by calendar arithmetic", () => {
    assert.equal(mod.addDays("2026-01-31", 1), "2026-02-01");
    assert.equal(mod.addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(mod.addDays("2026-02-28", 1), "2026-03-01");
    assert.equal(mod.addDays("2028-02-28", 1), "2028-02-29");
    assert.equal(
      mod.addDays("2026-03-07", 1),
      "2026-03-08",
      "the day DST starts is still one day later"
    );
    assert.equal(mod.addDays("2026-10-31", 1), "2026-11-01", "the day DST ends too");
    assert.equal(mod.addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(mod.addDays("not a day", 1), "");
    assert.equal(mod.addDays("", 1), "");
  });

  await it("eventStartDay takes a bare date as-is and reads a full instant in America/New_York", () => {
    assert.equal(mod.eventStartDay({ date: "2026-08-29" }), "2026-08-29");
    assert.equal(mod.eventStartDay({ date: "2026-10-17T09:00:00-04:00" }), "2026-10-17");
    // A bare date must NOT go through Date.parse: that reads UTC midnight,
    // which is the previous evening in New York.
    assert.equal(mod.eventStartDay({ date: "2026-01-01" }), "2026-01-01");
    // The last minute of a New York day, expressed in UTC, is still that day.
    assert.equal(mod.eventStartDay({ date: "2026-09-03T03:59:00Z" }), "2026-09-02");
    assert.equal(mod.eventStartDay({ date: "2026-09-03T04:00:00Z" }), "2026-09-03");
    // Year boundary.
    assert.equal(mod.eventStartDay({ date: "2027-01-01T04:59:00Z" }), "2026-12-31");
    assert.equal(mod.eventStartDay({ date: "2027-01-01T05:00:00Z" }), "2027-01-01");
    // DST starts 2026-03-08 (EST -> EDT): midnight moves from 05:00Z to 04:00Z.
    assert.equal(mod.eventStartDay({ date: "2026-03-08T01:30:00-05:00" }), "2026-03-08");
    assert.equal(mod.eventStartDay({ date: "2026-03-08T03:30:00-04:00" }), "2026-03-08");
    assert.equal(mod.eventStartDay({ date: "2026-03-08T04:59:00Z" }), "2026-03-07");
    assert.equal(mod.eventStartDay({ date: "2026-03-09T03:59:00Z" }), "2026-03-08");
    assert.equal(mod.eventStartDay({ date: "2026-03-09T04:00:00Z" }), "2026-03-09");
    // DST ends 2026-11-01 (EDT -> EST): midnight moves from 04:00Z back to 05:00Z.
    assert.equal(mod.eventStartDay({ date: "2026-11-01T01:30:00-04:00" }), "2026-11-01");
    assert.equal(mod.eventStartDay({ date: "2026-11-01T01:30:00-05:00" }), "2026-11-01");
    assert.equal(mod.eventStartDay({ date: "2026-11-01T03:59:00Z" }), "2026-10-31");
    assert.equal(mod.eventStartDay({ date: "2026-11-02T04:59:00Z" }), "2026-11-01");
    assert.equal(mod.eventStartDay({ date: "2026-11-02T05:00:00Z" }), "2026-11-02");
    // Garbage.
    assert.equal(mod.eventStartDay({ date: "" }), "");
    assert.equal(mod.eventStartDay({}), "");
    assert.equal(mod.eventStartDay(null), "");
    assert.equal(mod.eventStartDay({ date: "someday" }), "");
    assert.equal(
      mod.eventStartDay({ date: "2026-10-17Tgarbage" }),
      "2026-10-17",
      "a broken time keeps its day"
    );
  });

  await it("eventsStartingOn matches both spellings across a month and a year boundary", () => {
    const events = {
      upcoming: [
        { id: "iso-feb", date: "2026-02-01T10:00:00-05:00" },
        { id: "bare-feb", date: "2026-02-01" },
        { id: "late-jan-utc", date: "2026-02-01T04:30:00Z" }, // still Jan 31 in NY
        { id: "feb-2", date: "2026-02-02" },
        { id: "new-year", date: "2027-01-01T09:00:00-05:00" },
        { date: "2026-02-01" }, // no id -> never matched
        null
      ],
      past: [{ id: "old", date: "2026-02-01" }]
    };
    assert.deepEqual(
      mod.eventsStartingOn(events, mod.addDays("2026-01-31", 1)).map((e) => e.id),
      ["iso-feb", "bare-feb"]
    );
    assert.deepEqual(
      mod.eventsStartingOn(events, mod.addDays("2026-12-31", 1)).map((e) => e.id),
      ["new-year"]
    );
    assert.deepEqual(
      mod.eventsStartingOn(events, "2026-01-31").map((e) => e.id),
      ["late-jan-utc"]
    );
    assert.deepEqual(mod.eventsStartingOn({ upcoming: [] }, "2026-02-01"), []);
    assert.deepEqual(mod.eventsStartingOn(null, "2026-02-01"), []);
  });

  await it("marketReminderEmail is a date and a place, escaped, with no discount and no urgency", () => {
    const msg = mod.marketReminderEmail(
      { id: "x", name: "Salt & <Smoke> Fair", dateLabel: "May 9, 2026", location: "Landrum, SC" },
      "Come say hey.",
      SITE
    );
    assert.equal(msg.subject, "Tomorrow: Salt & <Smoke> Fair");
    assert.ok(msg.html.includes("Salt &amp; &lt;Smoke&gt; Fair"), "HTML is escaped");
    assert.ok(msg.text.includes("What: Salt & <Smoke> Fair"));
    assert.ok(msg.text.includes("When: May 9, 2026"));
    assert.ok(msg.text.includes("Where: Landrum, SC"));
    assert.ok(msg.text.includes(`${SITE}/events.html`));
    assert.ok(!/discount|% off|hurry|last chance/i.test(msg.text + msg.html));
    const bare = mod.marketReminderEmail({ id: "y", name: "Bare", date: "2026-05-09" }, "Hi", SITE);
    assert.ok(bare.text.includes("When: 2026-05-09"), "no dateLabel falls back to the start day");
    assert.ok(!bare.text.includes("Where:"), "no location, no Where row");
  });

  /* ================================================= runMarketReminders */
  console.log("\n--- runMarketReminders: the gates ---");
  await it("site.enableMarketReminders = false switches it off without burning the day", async () => {
    const env = await makeEnv();
    subscribe(env, "one@example.com", 1, CONSENT_TEXT);
    const off = { site: { ...CONTENT.site, enableMarketReminders: false } };
    const out = await withMocks(
      async (calls) => {
        const result = await mod.runMarketReminders(env, noCtx, NOON_NY);
        assert.equal(calls.resend.length, 0);
        return result;
      },
      { content: off }
    );
    assert.deepEqual(out, { reason: "disabled" });
    assert.equal(await state.getJobState(env.STATE_DB, MARKET_REMINDER_JOB), null);
  });

  await it("before the configured hour it is too early, and the day is not claimed", async () => {
    const env = await makeEnv();
    subscribe(env, "one@example.com", 1, CONSENT_TEXT);
    await withMocks(async (calls) => {
      assert.deepEqual(await mod.runMarketReminders(env, noCtx, DAWN_NY), {
        reason: "too-early",
        day: TODAY
      });
      assert.equal(calls.resend.length, 0);
    });
    assert.equal(await state.getJobState(env.STATE_DB, MARKET_REMINDER_JOB), null);
    // No automations block at all -> DEFAULT_REMINDER_HOUR (9), so 5am is still early.
    await withMocks(
      async () => {
        assert.equal(
          (await mod.runMarketReminders(env, noCtx, DAWN_NY)).reason,
          "too-early",
          "the default hour applies when the CMS has none"
        );
      },
      { content: { site: { enableMarketReminders: true } } }
    );
    // An explicit 0 is honoured as "any hour", not treated as unset.
    await withMocks(
      () =>
        captureLogs(async () => {
          assert.notEqual(
            (await mod.runMarketReminders(env, noCtx, DAWN_NY)).reason,
            "too-early",
            "marketReminderHour: 0 runs on the first tick of the day"
          );
        }),
      { content: { site: { enableMarketReminders: true, automations: { marketReminderHour: 0 } } } }
    );
    assert.equal(mod.DEFAULT_REMINDER_HOUR, 9);
  });

  await it("a missing MAGIC_LINK_SECRET or RESEND_API_KEY is a quiet skip that does not burn the day", async () => {
    for (const missing of ["MAGIC_LINK_SECRET", "RESEND_API_KEY"]) {
      const env = await makeEnv({ [missing]: undefined });
      subscribe(env, "one@example.com", 1, CONSENT_TEXT);
      const { value, logs } = await withMocks((calls) =>
        captureLogs(async () => {
          const result = await mod.runMarketReminders(env, noCtx, NOON_NY);
          assert.equal(calls.resend.length, 0, `${missing}: nothing sent`);
          return result;
        })
      );
      assert.deepEqual(value, { reason: "unconfigured", day: TODAY }, missing);
      assert.match(logs, /MAGIC_LINK_SECRET or RESEND_API_KEY/);
      assert.ok(!logs.includes("one@example.com"), "no address in the log");
      assert.equal(
        await state.getJobState(env.STATE_DB, MARKET_REMINDER_JOB),
        null,
        `${missing}: the day is not claimed, so setting the secret later still sends`
      );
    }
  });

  await it("with no STATE_DB it does nothing", async () => {
    assert.deepEqual(await mod.runMarketReminders({}, noCtx, NOON_NY), { reason: "no-database" });
    assert.deepEqual(await mod.runMarketReminders(null, noCtx, NOON_NY), { reason: "no-database" });
  });

  await it("no market tomorrow: claims the day, sends nothing, says so", async () => {
    const env = await makeEnv();
    subscribe(env, "one@example.com", 1, CONSENT_TEXT);
    const out = await withMocks(
      async (calls) => {
        const result = await mod.runMarketReminders(env, noCtx, NOON_NY);
        assert.equal(calls.resend.length, 0);
        return result;
      },
      { events: { upcoming: [EVENTS.upcoming[2]], past: EVENTS.past } }
    );
    assert.deepEqual(out, {
      reason: "no-market-tomorrow",
      day: TODAY,
      events: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      truncated: false
    });
    assert.equal(await state.getJobState(env.STATE_DB, MARKET_REMINDER_JOB), TODAY);
    assert.equal(
      subscribers(env)[0].last_event_id,
      null,
      "nobody is marked for a market that is not tomorrow"
    );
  });

  await it("the same New York day is never run twice", async () => {
    const env = await makeEnv();
    subscribe(env, "one@example.com", 1, CONSENT_TEXT);
    await withMocks(async (calls) => {
      const first = await mod.runMarketReminders(env, noCtx, NOON_NY);
      assert.equal(first.reason, "ran");
      const sentAfterFirst = calls.resend.length;
      assert.ok(sentAfterFirst > 0);
      assert.deepEqual(await mod.runMarketReminders(env, noCtx, NOON_NY + 3600 * 1000), {
        reason: "already-ran",
        day: TODAY
      });
      assert.equal(calls.resend.length, sentAfterFirst, "the next hour's tick sends nothing");
    });
  });

  console.log("\n--- runMarketReminders: the sends ---");
  await it("sends one reminder per subscriber per market tomorrow, keyed market-<eventId>-<sha256>", async () => {
    const env = await makeEnv();
    subscribe(env, "first@example.com", 1, CONSENT_TEXT);
    subscribe(env, "second@example.com", 2, CONSENT_TEXT);
    assert.equal(mod.addDays(TODAY, 1), TOMORROW);
    assert.deepEqual(
      mod.eventsStartingOn(EVENTS, TOMORROW).map((e) => e.id),
      ["wed-market", "bare-day-market"],
      "the fixture has two markets tomorrow and one later"
    );
    const { value, logs } = await withMocks((calls) =>
      captureLogs(async () => {
        const result = await mod.runMarketReminders(env, noCtx, NOON_NY);
        assert.deepEqual(result, {
          reason: "ran",
          day: TODAY,
          events: 2,
          sent: 4,
          skipped: 0,
          failed: 0,
          truncated: false
        });
        assert.equal(calls.resend.length, 4, "2 subscribers x 2 markets tomorrow");

        const keys = calls.resend.map((c) => c.headers["Idempotency-Key"]);
        assert.deepEqual(
          keys.slice().sort(),
          [
            `market-bare-day-market-${sha256("first@example.com")}`,
            `market-bare-day-market-${sha256("second@example.com")}`,
            `market-wed-market-${sha256("first@example.com")}`,
            `market-wed-market-${sha256("second@example.com")}`
          ].sort()
        );
        assert.equal(new Set(keys).size, 4, "every key is distinct");
        for (const call of calls.resend) {
          assert.equal(call.message.headers["X-Entity-Ref-ID"], call.headers["Idempotency-Key"]);
          assert.ok(call.message.headers["List-Unsubscribe"], "RFC 8058 header (a marketing send)");
          assert.equal(call.message.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
          assert.ok(
            !/@/.test(call.message.headers["List-Unsubscribe"].split("<")[1].split(">")[0]),
            "the unsubscribe URL carries no address"
          );
          assert.ok(
            call.message.text.includes(INTRO),
            "the CMS intro (site.automations.marketReminderIntro)"
          );
          assert.ok(/unsubscribe/i.test(call.message.text), "the visible opt-out line");
          assert.ok(call.message.text.includes(`${SITE}/events.html`));
        }
        const wed = calls.resend.filter(
          (c) => c.message.subject === "Tomorrow: Landrum Wednesday Market"
        );
        assert.equal(wed.length, 2);
        assert.deepEqual(wed.map((c) => c.message.to).sort(), [
          "first@example.com",
          "second@example.com"
        ]);
        assert.ok(wed[0].message.text.includes("Where: Landrum, SC"));
        assert.ok(wed[0].message.text.includes("When: September 2, 2026"));
        assert.equal(
          calls.resend.filter((c) => c.message.subject === "Tomorrow: Tryon Bare-Date Market")
            .length,
          2,
          "a bare-date market is matched too"
        );
        assert.ok(
          !calls.resend.some((c) => /Later Market/.test(c.message.subject)),
          "a market three days out is not sent"
        );
        return result;
      })
    );
    assert.equal(value.reason, "ran");
    const rows = subscribers(env);
    assert.deepEqual(
      rows.map((r) => [r.last_event_id, r.last_sent_at]),
      [
        ["bare-day-market", NOON_NY],
        ["bare-day-market", NOON_NY]
      ],
      "last_event_id is the last market sent and last_sent_at is the run's clock"
    );
    assert.equal(await state.getJobState(env.STATE_DB, MARKET_REMINDER_JOB), TODAY);
    assert.match(logs, /market-reminders: 2026-09-01 -> 4 sent, 0 skipped, 0 failed/);
    assert.ok(!/@example\.com/.test(logs), "no email address in console output");
  });

  await it("a suppressed address is counted as skipped, never mailed, and marked so it is not reconsidered", async () => {
    const env = await makeEnv();
    subscribe(env, "quiet@example.com", 1, CONSENT_TEXT);
    subscribe(env, "loud@example.com", 2, CONSENT_TEXT);
    await retention.suppressEmail(env.STATE_DB, "Quiet@Example.com", "unsubscribe", NOON_NY - 1000);
    await withMocks(
      async (calls) => {
        const result = await mod.runMarketReminders(env, noCtx, NOON_NY);
        assert.equal(result.sent, 1);
        assert.equal(result.skipped, 1);
        assert.equal(result.failed, 0);
        assert.equal(result.truncated, false);
        assert.deepEqual(
          calls.resend.map((c) => c.message.to),
          ["loud@example.com"]
        );
      },
      { events: { upcoming: [EVENTS.upcoming[0]], past: [] } }
    );
    const quiet = subscribers(env).find((r) => r.email === "quiet@example.com");
    assert.equal(
      quiet.last_event_id,
      "wed-market",
      "marked: reconsidering an opt-out every day is its own bug"
    );
    assert.equal(
      await state.getJobState(env.STATE_DB, MARKET_REMINDER_JOB),
      TODAY,
      "a skip does not re-open the day"
    );
  });

  await it("a refused send is counted as failed, left unmarked, logged by hash only, and retried on the next tick", async () => {
    const env = await makeEnv();
    subscribe(env, "refused@example.com", 1, CONSENT_TEXT);
    subscribe(env, "fine@example.com", 2, CONSENT_TEXT);
    const oneEvent = { events: { upcoming: [EVENTS.upcoming[0]], past: [] } };
    const { value, logs } = await withMocks(
      (calls) =>
        captureLogs(async () => {
          const result = await mod.runMarketReminders(env, noCtx, NOON_NY);
          assert.equal(calls.resend.length, 2, "Resend was asked for both");
          return result;
        }),
      { ...oneEvent, refuse: (m) => m.to === "refused@example.com" }
    );
    assert.equal(value.sent, 1);
    assert.equal(value.failed, 1);
    assert.equal(value.skipped, 0);
    const rows = subscribers(env);
    assert.equal(
      rows.find((r) => r.email === "refused@example.com").last_event_id,
      null,
      "left unmarked"
    );
    assert.equal(rows.find((r) => r.email === "fine@example.com").last_event_id, "wed-market");
    assert.ok(logs.includes(sha256("refused@example.com")), "the refusal is logged by hash");
    assert.ok(!/@example\.com/.test(logs), "and never by address");
    assert.equal(
      await state.getJobState(env.STATE_DB, MARKET_REMINDER_JOB),
      `${TODAY}:partial`,
      "the day marker is re-opened so the next hourly tick retries"
    );

    // Next tick, Resend healthy: only the refused subscriber is sent again.
    await withMocks(async (calls) => {
      const again = await mod.runMarketReminders(env, noCtx, NOON_NY + 3600 * 1000);
      assert.equal(again.reason, "ran");
      assert.equal(again.sent, 1);
      assert.equal(again.failed, 0);
      assert.deepEqual(
        calls.resend.map((c) => c.message.to),
        ["refused@example.com"]
      );
      assert.equal(
        calls.resend[0].headers["Idempotency-Key"],
        `market-wed-market-${sha256("refused@example.com")}`,
        "the same key, so a send that had actually landed is a no-op at Resend"
      );
    }, oneEvent);
    assert.equal(
      await state.getJobState(env.STATE_DB, MARKET_REMINDER_JOB),
      TODAY,
      "and now the day is closed"
    );
  });

  await it(`the ${MARKET_REMINDER_BATCH}-per-run budget reports truncated=true and drains on the next tick`, async () => {
    assert.equal(MARKET_REMINDER_BATCH, 50);
    const env = await makeEnv();
    const total = MARKET_REMINDER_BATCH + 5;
    for (let i = 0; i < total; i++) {
      subscribe(env, `sub${String(i).padStart(3, "0")}@example.com`, i + 1, CONSENT_TEXT);
    }
    const oneEvent = { events: { upcoming: [EVENTS.upcoming[0]], past: [] } };
    await withMocks(async (calls) => {
      const first = await mod.runMarketReminders(env, noCtx, NOON_NY);
      assert.equal(first.sent, MARKET_REMINDER_BATCH);
      assert.equal(first.truncated, true);
      assert.equal(calls.resend.length, MARKET_REMINDER_BATCH);
      assert.equal(
        await state.getJobState(env.STATE_DB, MARKET_REMINDER_JOB),
        `${TODAY}:partial`,
        "the day marker is rewritten so the next tick re-claims"
      );
      assert.equal(
        subscribers(env).filter((r) => r.last_event_id === "wed-market").length,
        MARKET_REMINDER_BATCH,
        "exactly the budget is marked"
      );

      const second = await mod.runMarketReminders(env, noCtx, NOON_NY + 3600 * 1000);
      assert.equal(second.reason, "ran");
      assert.equal(second.sent, total - MARKET_REMINDER_BATCH);
      assert.equal(second.truncated, false);
      assert.equal(calls.resend.length, total, "everyone is reached once");
      assert.equal(new Set(calls.resend.map((c) => c.message.to)).size, total, "and nobody twice");
      assert.equal(await state.getJobState(env.STATE_DB, MARKET_REMINDER_JOB), TODAY);

      const third = await mod.runMarketReminders(env, noCtx, NOON_NY + 2 * 3600 * 1000);
      assert.equal(third.reason, "already-ran");
      assert.equal(calls.resend.length, total);
    }, oneEvent);
  });

  await it("a second market the budget never reached also reports truncated=true", async () => {
    const env = await makeEnv();
    for (let i = 0; i < MARKET_REMINDER_BATCH; i++) {
      subscribe(env, `sub${String(i).padStart(3, "0")}@example.com`, i + 1, CONSENT_TEXT);
    }
    await withMocks(async (calls) => {
      const first = await mod.runMarketReminders(env, noCtx, NOON_NY);
      assert.equal(first.events, 2);
      assert.equal(first.sent, MARKET_REMINDER_BATCH);
      assert.equal(first.truncated, true, "the whole budget went to the first market");
      assert.ok(calls.resend.every((c) => /Wednesday/.test(c.message.subject)));

      const second = await mod.runMarketReminders(env, noCtx, NOON_NY + 3600 * 1000);
      assert.equal(second.sent, MARKET_REMINDER_BATCH);
      assert.equal(second.truncated, false);
      assert.equal(calls.resend.length, 2 * MARKET_REMINDER_BATCH);
      assert.ok(
        calls.resend.slice(MARKET_REMINDER_BATCH).every((c) => /Bare-Date/.test(c.message.subject))
      );
    });
  });

  await it("no email address reaches the console on any path", async () => {
    const addresses = ["logged@example.com", "other@example.com"];
    const scenarios = [
      ["a normal run", {}],
      ["a refused send", { refuse: () => true }],
      ["no market tomorrow", { events: { upcoming: [], past: [] } }],
      ["switched off", { content: { site: { enableMarketReminders: false } } }]
    ];
    for (const [label, options] of scenarios) {
      const env = await makeEnv();
      addresses.forEach((a, i) => subscribe(env, a, i + 1, CONSENT_TEXT));
      const { logs } = await withMocks(
        () => captureLogs(() => mod.runMarketReminders(env, noCtx, NOON_NY)),
        options
      );
      for (const a of addresses)
        assert.ok(!logs.includes(a), `${label}: "${a}" is not in the logs`);
      assert.ok(!logs.includes("@example.com"), `${label}: no address at all`);
    }
    // The route too, on every outcome it can produce.
    const env = await makeEnv();
    const { logs } = await withMocks(() =>
      captureLogs(async () => {
        await worker.fetch(postJson({ email: "logged@example.com" }), env, noCtx);
        await worker.fetch(postJson({ email: "logged@example.com" }), env, noCtx);
        await worker.fetch(postJson({ email: "nope" }), env, noCtx);
        await worker.fetch(postJson({ email: "logged@example.com", website_hp: "x" }), env, noCtx);
        await worker.fetch(postForm({ email: "logged@example.com" }), env, noCtx);
      })
    );
    assert.ok(!logs.includes("logged@example.com"), "the route logs no address");
  });

  console.log(`\nworker-market-alerts.test.js: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("FAILED:\n  " + failures.join("\n  "));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
