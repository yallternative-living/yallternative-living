/**
 * @fileoverview Unit tests for the monthly adverse-event export:
 *   - workers/routes/reaction-export.js  (the month arithmetic, the CSV --
 *                                         quoting and formula neutralisation --
 *                                         and runReactionExport: every gate,
 *                                         the query window, the attachment,
 *                                         the subject, the recipient fallback,
 *                                         the idempotency key, a refused send,
 *                                         and what may reach a log line)
 *
 * Node only, no network, no wrangler. D1 is the `node:sqlite` emulator
 * (scripts/lib/d1-emulator.js) with the real migrations applied, wrapped in a
 * recorder so the SELECT's bind values can be asserted. content.json and
 * Resend are served by one `global.fetch` stub. The job is driven through its
 * real exported entry point, `runReactionExport`, with an explicit `now`.
 *
 * Run: node scripts/worker-reaction-export.test.js
 */

const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { makeD1 } = require("./lib/d1-emulator.js");

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
const noCtx = { waitUntil: () => {} };

/** 2026-09-01 07:00 America/New_York (EDT): the first morning of a new month. */
const FIRST_OF_SEPT = Date.UTC(2026, 8, 1, 11, 0, 0);
const THIS_MONTH = "2026-09";
const LAST_MONTH = "2026-08";
/** August 2026 in New York: [Aug 1 00:00 EDT, Sep 1 00:00 EDT). */
const AUG_START = Date.UTC(2026, 7, 1, 4, 0, 0);
const AUG_END = Date.UTC(2026, 8, 1, 4, 0, 0);

const CONTENT = { site: { enableReactionExport: true } };

/** One adverse_events row, shaped exactly as workers/routes/safety-report.js writes it. */
function report(id, createdAt, extra = {}) {
  return {
    id,
    created_at: createdAt,
    product_id: "frankincense-salve",
    lot: "L-2026-07-A",
    channel: "site",
    first_use_date: "2026-08-01",
    reaction_date: "2026-08-03",
    body_area: "left forearm",
    description: "It stung, then went red.",
    outcomes: '["doctor-visit"]',
    stopped_use: "yes",
    reporter_name: "Dana Reporter",
    reporter_email: "dana.reporter@example.com",
    reporter_phone: "+1 864 555 0199",
    age_range: "25-34",
    sex: "female",
    contact_consent: 1,
    serious: 0,
    status: "new",
    ip_hash: "ab12cd34ef56",
    ...extra
  };
}

/** Strings that must never appear in a log line. Taken from the fixtures above. */
const REPORT_SECRETS = [
  "It stung",
  "Dana Reporter",
  "dana.reporter@example.com",
  "864 555 0199",
  "L-2026-07-A",
  "left forearm",
  "HYPERLINK"
];

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
  const { applyMigrations, resetSchemaMemo } = await import("../workers/state/migrations.js");
  resetSchemaMemo();
  const db = recordingD1(makeD1(new DatabaseSync(":memory:")));
  await applyMigrations(db);
  const env = {
    SITE_ORIGIN: SITE,
    RESEND_API_KEY: "re_test_export",
    STATE_DB: db,
    ...overrides
  };
  Object.keys(overrides).forEach((k) => {
    if (overrides[k] === undefined) delete env[k];
  });
  return env;
}

function insertReport(env, row) {
  const columns = Object.keys(row);
  env.STATE_DB._raw
    .prepare(
      `INSERT INTO adverse_events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
    )
    .run(...columns.map((c) => row[c]));
}

/** Swap global.fetch for a recorder answering content.json and Resend. */
async function withMocks(fn, options = {}) {
  const original = global.fetch;
  const calls = { resend: [] };
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("content.json")) {
      return { ok: true, status: 200, json: async () => options.content || CONTENT };
    }
    if (u.includes("api.resend.com")) {
      if (options.transportFails) throw new TypeError("fetch failed: ECONNRESET");
      calls.resend.push({
        message: JSON.parse((init && init.body) || "{}"),
        headers: (init && init.headers) || {}
      });
      if (options.resendFails) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ id: "email_1" }) };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    return await fn(calls);
  } finally {
    global.fetch = original;
  }
}

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

/** Decode a Resend attachment back to the text that was attached. */
const decodeAttachment = (call) =>
  Buffer.from(call.message.attachments[0].content, "base64").toString("utf8");

/** RFC 4180 row -> cells, so a file is checked by decoding it, not by counting commas. */
function parseCsvRow(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

/* ========================================================================== */

(async () => {
  const mod = await import("../workers/routes/reaction-export.js");
  const state = await import("../workers/state/job-state.js");
  const { EXPORT_COLUMNS, REACTION_EXPORT_JOB, DEFAULT_EXPORT_EMAIL } = mod;

  /* ======================================================= month maths */
  console.log("\n--- previousMonth / monthWindow / monthLabel ---");
  await it("previousMonth steps back one month and crosses the year", () => {
    assert.equal(mod.previousMonth("2026-09"), "2026-08");
    assert.equal(mod.previousMonth("2026-01"), "2025-12");
    assert.equal(mod.previousMonth("2026-03"), "2026-02");
    assert.equal(mod.previousMonth("2026-10"), "2026-09");
    assert.equal(mod.previousMonth("nope"), "");
    assert.equal(mod.previousMonth(""), "");
  });

  await it("monthWindow is [local midnight on the 1st, local midnight on the next 1st) in New York", () => {
    assert.deepEqual(mod.monthWindow("2026-08"), { start: AUG_START, end: AUG_END });
    // December -> January: EST both ends.
    assert.deepEqual(mod.monthWindow("2025-12"), {
      start: Date.UTC(2025, 11, 1, 5),
      end: Date.UTC(2026, 0, 1, 5)
    });
    // March 2026 holds the spring-forward (Mar 8): starts EST, ends EDT.
    assert.deepEqual(mod.monthWindow("2026-03"), {
      start: Date.UTC(2026, 2, 1, 5),
      end: Date.UTC(2026, 3, 1, 4)
    });
    // November 2026 holds the fall-back (Nov 1): starts EDT, ends EST.
    assert.deepEqual(mod.monthWindow("2026-11"), {
      start: Date.UTC(2026, 10, 1, 4),
      end: Date.UTC(2026, 11, 1, 5)
    });
    assert.equal(
      mod.monthWindow("2026-11").end - mod.monthWindow("2026-11").start,
      30 * 86400000 + 3600000
    );
    assert.equal(
      mod.monthWindow("2026-03").end - mod.monthWindow("2026-03").start,
      31 * 86400000 - 3600000
    );
    assert.ok(Number.isNaN(mod.zonedMonthStart("garbage")));
  });

  await it("monthLabel names the month in English, including January's December", () => {
    assert.equal(mod.monthLabel("2026-08"), "August 2026");
    assert.equal(mod.monthLabel(mod.previousMonth("2026-01")), "December 2025");
    assert.equal(mod.monthLabel("2026-03"), "March 2026");
    assert.equal(mod.monthLabel("2026-11"), "November 2026");
    assert.equal(mod.monthLabel("2026-01"), "January 2026");
    assert.equal(mod.monthLabel("garbage"), "garbage", "an unparseable key is echoed, not thrown");
  });

  /* =============================================================== CSV */
  console.log("\n--- csvField / csvValue / buildCsv ---");
  await it("csvField quotes commas, double quotes, newlines and edge whitespace per RFC 4180", () => {
    assert.equal(mod.csvField("plain"), "plain");
    assert.equal(mod.csvField("a,b"), '"a,b"');
    assert.equal(mod.csvField('say "hi"'), '"say ""hi"""');
    assert.equal(mod.csvField("line one\nline two"), '"line one\nline two"');
    assert.equal(mod.csvField("cr\rlf\n"), '"cr\rlf\n"');
    assert.equal(mod.csvField(" padded"), '" padded"');
    assert.equal(mod.csvField("padded "), '"padded "');
    assert.equal(mod.csvField(null), "");
    assert.equal(mod.csvField(undefined), "");
    assert.equal(mod.csvField(""), "");
    assert.equal(mod.csvField(0), "0", "a numeric zero is not an empty cell");
    assert.equal(mod.csvField(1756700000000), "1756700000000");
    assert.equal(mod.csvField("it burned — badly"), "it burned — badly");
  });

  await it("csvField neutralises a leading = + - @ tab or CR so the owner's spreadsheet never runs it", () => {
    assert.equal(mod.csvField("=1+1"), '"\'=1+1"');
    assert.equal(
      mod.csvField('=HYPERLINK("http://evil.example","click")'),
      '"\'=HYPERLINK(""http://evil.example"",""click"")"'
    );
    assert.equal(mod.csvField("=cmd|' /C calc'!A0"), "\"'=cmd|' /C calc'!A0\"");
    assert.equal(mod.csvField("+1 864 555 0199"), '"\'+1 864 555 0199"');
    assert.equal(mod.csvField("-2+3"), '"\'-2+3"');
    assert.equal(mod.csvField("@SUM(A1:A9)"), '"\'@SUM(A1:A9)"');
    assert.equal(mod.csvField("\t=1+1"), '"\'\t=1+1"');
    assert.equal(mod.csvField("\r=1+1"), '"\'\r=1+1"');
    // Only a LEADING character is a formula; the same characters elsewhere are text.
    assert.equal(mod.csvField("2 + 2"), "2 + 2");
    assert.equal(mod.csvField("email@example.com"), "email@example.com");
    assert.equal(mod.csvField("YL-AE-ABCD-1234"), "YL-AE-ABCD-1234");
    assert.equal(mod.csvField("2026-08-03"), "2026-08-03");
    // Neutralised AND quoted: every cell that gets the apostrophe is wrapped, so
    // a quote-stripping importer still sees the apostrophe first.
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      const out = mod.csvField(`${lead}x`);
      assert.equal(out, `"'${lead}x"`, JSON.stringify(lead));
      assert.equal(
        parseCsvRow(out)[0][0],
        "'",
        `${JSON.stringify(lead)}: a spreadsheet sees the apostrophe first`
      );
    }
  });

  await it("csvValue flattens the outcomes JSON to a|b and renders created_at as ISO", () => {
    assert.equal(
      mod.csvValue({ outcomes: '["infection","doctor-visit"]' }, "outcomes"),
      "infection|doctor-visit"
    );
    assert.equal(mod.csvValue({ outcomes: '["cleared-up"]' }, "outcomes"), "cleared-up");
    assert.equal(mod.csvValue({ outcomes: "[]" }, "outcomes"), "");
    assert.equal(mod.csvValue({ outcomes: null }, "outcomes"), "");
    assert.equal(
      mod.csvValue({ outcomes: "infection" }, "outcomes"),
      "infection",
      "non-JSON is passed through"
    );
    assert.equal(
      mod.csvValue({ outcomes: '{"a":1}' }, "outcomes"),
      '{"a":1}',
      "JSON that is not an array is passed through"
    );
    assert.equal(mod.csvValue({ created_at: AUG_START }, "created_at"), "2026-08-01T04:00:00.000Z");
    assert.equal(mod.csvValue({ created_at: "soon" }, "created_at"), "soon");
    assert.equal(mod.csvValue({ lot: null }, "lot"), "");
    assert.equal(mod.csvValue({ serious: 1 }, "serious"), "1");
    assert.equal(mod.csvValue({ serious: 0 }, "serious"), "0");
    assert.equal(mod.csvValue(undefined, "lot"), "");
    assert.equal(mod.csvValue({}, "reporter_name"), "");
  });

  await it("buildCsv writes the header row from EXPORT_COLUMNS, one CRLF row per report, plus the raw epoch", () => {
    assert.deepEqual(
      EXPORT_COLUMNS,
      [
        "id",
        "created_at",
        "product_id",
        "lot",
        "channel",
        "first_use_date",
        "reaction_date",
        "body_area",
        "description",
        "outcomes",
        "stopped_use",
        "reporter_name",
        "reporter_email",
        "reporter_phone",
        "age_range",
        "sex",
        "contact_consent",
        "serious",
        "status",
        "ip_hash"
      ],
      "every column of adverse_events in schema order -- a MedWatch 3500A needs all of it"
    );
    const empty = mod.buildCsv([]);
    const lines = empty.split("\r\n");
    assert.equal(lines.length, 2, "header, terminator, nothing else");
    assert.equal(lines[1], "");
    const header = lines[0].split(",");
    assert.deepEqual(header.slice(0, EXPORT_COLUMNS.length), EXPORT_COLUMNS);
    assert.deepEqual(
      header.slice(EXPORT_COLUMNS.length),
      ["created_at_ms"],
      "the raw epoch rides along after the ISO timestamp"
    );
    assert.ok(
      !empty.includes("\n\n") && !/[^\r]\n/.test(empty),
      "CRLF everywhere, never a bare LF"
    );

    const csv = mod.buildCsv([
      report("YL-AE-AAAA-0001", AUG_START + 1000, {
        description: 'Red, itchy, "burning" -- see photo',
        outcomes: '["infection","doctor-visit"]',
        serious: 1
      }),
      report("YL-AE-BBBB-0002", AUG_START + 2000, { description: "=1+1", lot: null })
    ]);
    const rows = csv.split("\r\n");
    assert.equal(rows.length, 4);
    assert.ok(
      rows[1].startsWith(
        "YL-AE-AAAA-0001,2026-08-01T04:00:01.000Z,frankincense-salve,L-2026-07-A,site,2026-08-01,2026-08-03,left forearm,"
      )
    );
    assert.ok(
      rows[1].includes(
        '"Red, itchy, ""burning"" -- see photo",infection|doctor-visit,yes,Dana Reporter,dana.reporter@example.com,"\'+1 864 555 0199",25-34,female,1,1,new,ab12cd34ef56,' +
          (AUG_START + 1000)
      )
    );
    assert.ok(rows[2].includes(',"\'=1+1",'), "the formula is neutralised in the file");
    assert.ok(
      rows[2].includes("YL-AE-BBBB-0002,2026-08-01T04:00:02.000Z,frankincense-salve,,site,"),
      "a NULL lot is an empty cell"
    );
    const cells = parseCsvRow(rows[1]);
    assert.equal(
      cells.length,
      EXPORT_COLUMNS.length + 1,
      "the quoted commas do not shift the columns"
    );
    assert.equal(
      cells[EXPORT_COLUMNS.indexOf("description")],
      'Red, itchy, "burning" -- see photo',
      "and the description decodes back verbatim"
    );
    assert.equal(
      cells[EXPORT_COLUMNS.indexOf("reporter_phone")],
      "'+1 864 555 0199",
      "the phone keeps its apostrophe: text, not a formula"
    );
    assert.equal(cells[EXPORT_COLUMNS.indexOf("outcomes")], "infection|doctor-visit");
    assert.equal(
      cells[EXPORT_COLUMNS.length],
      String(AUG_START + 1000),
      "created_at_ms is the raw epoch"
    );
    assert.deepEqual(parseCsvRow(rows[0]), EXPORT_COLUMNS.concat(["created_at_ms"]));
    assert.equal(parseCsvRow(rows[2])[EXPORT_COLUMNS.indexOf("description")], "'=1+1");
  });

  await it("toBase64 survives characters above U+00FF and decodes back", () => {
    for (const text of ["plain", "it burned — badly", "café ☕", "\uFEFFid,created_at\r\n"]) {
      assert.equal(Buffer.from(mod.toBase64(text), "base64").toString("utf8"), text);
    }
    assert.equal(mod.toBase64(""), "");
  });

  await it("exportEmailBody counts, pluralises, and carries no report content", () => {
    const zero = mod.exportEmailBody("August 2026", 0, 0);
    assert.match(zero.text, /No reaction reports came in during August 2026/);
    assert.match(zero.text, /empty month's record/);
    const one = mod.exportEmailBody("August 2026", 1, 1);
    assert.match(one.text, /1 reaction report came in during August 2026, 1 of which was serious/);
    assert.match(one.text, /15 BUSINESS DAYS/);
    assert.match(one.text, /Form FDA 3500A/);
    const many = mod.exportEmailBody("August 2026", 3, 0);
    assert.match(
      many.text,
      /3 reaction reports came in during August 2026, 0 of which were serious/
    );
    assert.match(many.text, /three years/);
    assert.ok(!/15 BUSINESS DAYS/.test(many.text), "no FDA clock when nothing was serious");
    assert.ok(many.html.includes("<h2>Reaction reports: August 2026</h2>"));
    const escaped = mod.exportEmailBody("<b>x</b>", 0, 0);
    assert.ok(escaped.html.includes("&lt;b&gt;x&lt;/b&gt;"));
  });

  /* =================================================== runReactionExport */
  console.log("\n--- runReactionExport: the gates ---");
  await it("site.enableReactionExport = false switches it off without claiming the month", async () => {
    const env = await makeEnv();
    insertReport(env, report("YL-AE-AAAA-0001", AUG_START + 1000));
    const out = await withMocks(
      async (calls) => {
        const result = await mod.runReactionExport(env, noCtx, FIRST_OF_SEPT);
        assert.equal(calls.resend.length, 0);
        return result;
      },
      { content: { site: { enableReactionExport: false } } }
    );
    assert.deepEqual(out, { reason: "disabled" });
    assert.equal(await state.getJobState(env.STATE_DB, REACTION_EXPORT_JOB), null);
  });

  await it("with no STATE_DB it does nothing", async () => {
    assert.deepEqual(await mod.runReactionExport({}, noCtx, FIRST_OF_SEPT), {
      reason: "no-database"
    });
    assert.deepEqual(await mod.runReactionExport(null, noCtx, FIRST_OF_SEPT), {
      reason: "no-database"
    });
  });

  await it("a missing RESEND_API_KEY is a quiet skip, logged, that does not claim the month", async () => {
    const env = await makeEnv({ RESEND_API_KEY: undefined });
    insertReport(env, report("YL-AE-AAAA-0001", AUG_START + 1000));
    const { value, logs } = await withMocks((calls) =>
      captureLogs(async () => {
        const result = await mod.runReactionExport(env, noCtx, FIRST_OF_SEPT);
        assert.equal(calls.resend.length, 0);
        return result;
      })
    );
    assert.deepEqual(value, { reason: "unconfigured", month: LAST_MONTH });
    assert.match(logs, /RESEND_API_KEY/);
    assert.equal(
      await state.getJobState(env.STATE_DB, REACTION_EXPORT_JOB),
      null,
      "setting the key later still sends this month's file"
    );
    for (const secret of REPORT_SECRETS)
      assert.ok(!logs.includes(secret), `no "${secret}" in the logs`);
  });

  await it("a month that already ran is not run again", async () => {
    const env = await makeEnv();
    await state.setJobState(env.STATE_DB, REACTION_EXPORT_JOB, THIS_MONTH, FIRST_OF_SEPT - 3600000);
    await withMocks(async (calls) => {
      assert.deepEqual(await mod.runReactionExport(env, noCtx, FIRST_OF_SEPT), {
        reason: "already-ran",
        month: LAST_MONTH
      });
      assert.equal(calls.resend.length, 0);
    });
    // And the real thing: run, then the next hourly tick.
    const fresh = await makeEnv();
    await withMocks(async (calls) => {
      assert.equal((await mod.runReactionExport(fresh, noCtx, FIRST_OF_SEPT)).reason, "sent");
      assert.equal(
        (await mod.runReactionExport(fresh, noCtx, FIRST_OF_SEPT + 3600000)).reason,
        "already-ran"
      );
      assert.equal(calls.resend.length, 1, "one file a month, not twenty-four a day");
      assert.equal(await state.getJobState(fresh.STATE_DB, REACTION_EXPORT_JOB), THIS_MONTH);
    });
  });

  console.log("\n--- runReactionExport: the query and the file ---");
  await it("queries exactly the previous New York month, half-open", async () => {
    const env = await makeEnv();
    await withMocks(() => mod.runReactionExport(env, noCtx, FIRST_OF_SEPT));
    const select = env.STATE_DB._statements.find((s) => /FROM adverse_events/.test(s.sql));
    assert.ok(select, "one SELECT against adverse_events");
    assert.match(select.sql, /created_at >= \? AND created_at < \?/);
    assert.match(select.sql, /ORDER BY created_at/);
    assert.deepEqual(select.params, [AUG_START, AUG_END]);
    assert.deepEqual(select.params, [
      mod.monthWindow(LAST_MONTH).start,
      mod.monthWindow(LAST_MONTH).end
    ]);
    assert.ok(
      select.sql.includes(`SELECT ${EXPORT_COLUMNS.join(", ")} FROM adverse_events`),
      "every export column is selected by name"
    );
    assert.ok(
      !env.STATE_DB._statements.some((s) =>
        /DELETE FROM adverse_events|UPDATE adverse_events/.test(s.sql)
      ),
      "exporting is not archiving: nothing is deleted or changed"
    );
    // January's run reaches back into the previous year.
    const jan = await makeEnv();
    const { value } = await withMocks(() =>
      captureLogs(() => mod.runReactionExport(jan, noCtx, Date.UTC(2027, 0, 1, 12)))
    );
    assert.equal(value.month, "2026-12");
    const janSelect = jan.STATE_DB._statements.find((s) => /FROM adverse_events/.test(s.sql));
    assert.deepEqual(janSelect.params, [Date.UTC(2026, 11, 1, 5), Date.UTC(2027, 0, 1, 5)]);
  });

  await it("a month with no reports still sends the note, with a header-only file attached", async () => {
    const env = await makeEnv();
    const { value, logs } = await withMocks((calls) =>
      captureLogs(async () => {
        const result = await mod.runReactionExport(env, noCtx, FIRST_OF_SEPT);
        assert.equal(calls.resend.length, 1, "the zero-row email is the point");
        const call = calls.resend[0];
        assert.equal(call.message.subject, "Reaction reports: August 2026 (0 reports)");
        assert.match(call.message.text, /No reaction reports came in during August 2026/);
        assert.equal(call.message.attachments.length, 1);
        assert.equal(call.message.attachments[0].filename, "reaction-reports-2026-08.csv");
        const csv = decodeAttachment(call);
        assert.ok(csv.startsWith("\uFEFF"), "a BOM so Excel reads UTF-8");
        assert.equal(csv, `\uFEFF${mod.buildCsv([])}`);
        assert.equal(
          csv.slice(1).split("\r\n")[0].split(",").slice(0, EXPORT_COLUMNS.length).join(","),
          EXPORT_COLUMNS.join(",")
        );
        return result;
      })
    );
    assert.deepEqual(value, { reason: "sent", month: LAST_MONTH, rows: 0, serious: 0 });
    assert.match(logs, /reaction-export: 2026-08 -> 0 rows, 0 serious, sent/);
    assert.equal(await state.getJobState(env.STATE_DB, REACTION_EXPORT_JOB), THIS_MONTH);
  });

  await it("exports last month's rows only, in order, with the serious count in the subject", async () => {
    const env = await makeEnv();
    insertReport(
      env,
      report("YL-AE-CCCC-0003", AUG_START + 20 * 86400000, {
        description: '=HYPERLINK("http://evil.example","open me")',
        outcomes: '["infection","doctor-visit"]',
        serious: 1,
        reporter_name: "Sam, Jr."
      })
    );
    insertReport(
      env,
      report("YL-AE-AAAA-0001", AUG_START, { description: "At the boundary, first ms of August" })
    );
    insertReport(
      env,
      report("YL-AE-BBBB-0002", AUG_START + 3 * 86400000, {
        description: 'Red, "burning", then peeled'
      })
    );
    insertReport(
      env,
      report("YL-AE-DDDD-0004", AUG_END, {
        description: "First ms of September: next month's file"
      })
    );
    insertReport(
      env,
      report("YL-AE-EEEE-0005", AUG_START - 1, {
        description: "Last ms of July: last month's file"
      })
    );

    const { value, logs } = await withMocks((calls) =>
      captureLogs(async () => {
        const result = await mod.runReactionExport(env, noCtx, FIRST_OF_SEPT);
        assert.equal(calls.resend.length, 1);
        const call = calls.resend[0];
        assert.equal(call.message.subject, "Reaction reports: August 2026 (3 reports, 1 serious)");
        assert.match(
          call.message.text,
          /3 reaction reports came in during August 2026, 1 of which was serious/
        );
        assert.match(call.message.text, /15 BUSINESS DAYS/);
        for (const secret of REPORT_SECRETS) {
          assert.ok(
            !call.message.text.includes(secret) && !call.message.html.includes(secret),
            `the covering note carries no "${secret}"`
          );
        }
        assert.equal(call.message.attachments[0].filename, "reaction-reports-2026-08.csv");
        assert.equal(call.message.attachments.length, 1);

        const csv = decodeAttachment(call);
        assert.ok(csv.startsWith("\uFEFF"));
        const rows = csv.slice(1).split("\r\n");
        assert.equal(rows.length, 5, "header + 3 rows + terminator");
        assert.deepEqual(rows[0].split(",").slice(0, EXPORT_COLUMNS.length), EXPORT_COLUMNS);
        assert.deepEqual(
          rows.slice(1, 4).map((r) => r.split(",")[0]),
          ["YL-AE-AAAA-0001", "YL-AE-BBBB-0002", "YL-AE-CCCC-0003"],
          "ordered by created_at, boundary row included"
        );
        assert.ok(!csv.includes("YL-AE-DDDD-0004"), "the first ms of September is next month's");
        assert.ok(!csv.includes("YL-AE-EEEE-0005"), "the last ms of July was last month's");
        assert.ok(rows[3].includes("infection|doctor-visit"), "outcomes flattened to a|b");
        assert.ok(
          rows[3].includes('"\'=HYPERLINK(""http://evil.example"",""open me"")"'),
          "the formula in the description is neutralised"
        );
        assert.ok(rows[3].includes('"Sam, Jr."'), "a comma in a name is quoted");
        assert.ok(rows[2].includes('"Red, ""burning"", then peeled"'));
        assert.ok(
          rows[3].endsWith(`,1,new,ab12cd34ef56,${AUG_START + 20 * 86400000}`),
          "serious=1 and the raw epoch in the last cells"
        );
        for (const row of rows.slice(1, 4)) {
          assert.equal(
            parseCsvRow(row).length,
            EXPORT_COLUMNS.length + 1,
            "every row decodes to exactly the header's width"
          );
        }
        const serious = parseCsvRow(rows[3]);
        assert.equal(
          serious[EXPORT_COLUMNS.indexOf("description")],
          '\'=HYPERLINK("http://evil.example","open me")'
        );
        assert.equal(serious[EXPORT_COLUMNS.indexOf("reporter_name")], "Sam, Jr.");
        assert.equal(serious[EXPORT_COLUMNS.indexOf("serious")], "1");
        assert.ok(rows[1].includes(`,${AUG_START}`), "the raw epoch column");
        assert.ok(rows[1].includes("2026-08-01T04:00:00.000Z"), "and the ISO one");
        assert.ok(
          csv.includes("dana.reporter@example.com"),
          "the reporter's contact IS in the file -- that is what the file is for"
        );
        return result;
      })
    );
    assert.deepEqual(value, { reason: "sent", month: LAST_MONTH, rows: 3, serious: 1 });
    assert.match(logs, /reaction-export: 2026-08 -> 3 rows, 1 serious, sent/);
    for (const secret of REPORT_SECRETS)
      assert.ok(!logs.includes(secret), `no "${secret}" in the logs`);
    assert.ok(!/[A-Za-z0-9+/]{60,}={0,2}/.test(logs), "no base64 blob in the logs");
  });

  await it("goes to SAFETY_REPORT_EMAIL, then RESTOCK_NOTIFY_EMAIL, then the default -- and is not a marketing send", async () => {
    const cases = [
      [
        { SAFETY_REPORT_EMAIL: "safety@example.com", RESTOCK_NOTIFY_EMAIL: "shop@example.com" },
        "safety@example.com"
      ],
      [{ RESTOCK_NOTIFY_EMAIL: "shop@example.com" }, "shop@example.com"],
      [{}, DEFAULT_EXPORT_EMAIL]
    ];
    assert.equal(DEFAULT_EXPORT_EMAIL, "contact@yallternativeliving.com");
    for (const [vars, expected] of cases) {
      const env = await makeEnv(vars);
      await withMocks(async (calls) => {
        await mod.runReactionExport(env, noCtx, FIRST_OF_SEPT);
        assert.equal(calls.resend[0].message.to, expected, JSON.stringify(vars));
        const m = calls.resend[0].message;
        assert.ok(
          !m.headers || !m.headers["List-Unsubscribe"],
          "no List-Unsubscribe: a record-keeping notice to yourself"
        );
        assert.ok(!/unsubscribe/i.test(`${m.text}${m.html}`), "no opt-out line");
        assert.match(m.from, /@yallternativeliving\.com/);
      });
    }
    // The suppression list is not consulted: the owner cannot opt out of the law.
    const env = await makeEnv({ SAFETY_REPORT_EMAIL: "safety@example.com" });
    const retention = await import("../workers/state/retention.js");
    await retention.suppressEmail(
      env.STATE_DB,
      "safety@example.com",
      "unsubscribe",
      FIRST_OF_SEPT - 1
    );
    await withMocks(async (calls) => {
      assert.equal((await mod.runReactionExport(env, noCtx, FIRST_OF_SEPT)).reason, "sent");
      assert.equal(calls.resend[0].message.to, "safety@example.com");
    });
  });

  await it("the idempotency key is reaction-export-<month>, in both the header and X-Entity-Ref-ID", async () => {
    const env = await makeEnv();
    await withMocks(async (calls) => {
      await mod.runReactionExport(env, noCtx, FIRST_OF_SEPT);
      assert.equal(calls.resend[0].headers["Idempotency-Key"], "reaction-export-2026-08");
      assert.equal(calls.resend[0].message.headers["X-Entity-Ref-ID"], "reaction-export-2026-08");
      assert.equal(calls.resend[0].message.headers["Idempotency-Key"], "reaction-export-2026-08");
    });
    const jan = await makeEnv();
    await withMocks(async (calls) => {
      await mod.runReactionExport(jan, noCtx, Date.UTC(2027, 0, 1, 12));
      assert.equal(calls.resend[0].headers["Idempotency-Key"], "reaction-export-2026-12");
    });
  });

  await it("a refused send returns send-failed, re-opens the month, and the next tick sends", async () => {
    const env = await makeEnv();
    insertReport(env, report("YL-AE-AAAA-0001", AUG_START + 1000));
    const { value, logs } = await withMocks(
      (calls) =>
        captureLogs(async () => {
          const result = await mod.runReactionExport(env, noCtx, FIRST_OF_SEPT);
          assert.equal(calls.resend.length, 1, "Resend was asked");
          return result;
        }),
      { resendFails: true }
    );
    assert.deepEqual(value, { reason: "send-failed", month: LAST_MONTH, rows: 1, serious: 0 });
    assert.match(logs, /2026-08 export refused \(500\)/);
    assert.match(logs, /1 rows, 0 serious, NOT sent/);
    for (const secret of REPORT_SECRETS)
      assert.ok(!logs.includes(secret), `no "${secret}" in the logs`);
    assert.notEqual(
      await state.getJobState(env.STATE_DB, REACTION_EXPORT_JOB),
      THIS_MONTH,
      "a transient refusal must not burn the month: a silent month is the failure this job exists to rule out"
    );

    await withMocks(async (calls) => {
      const again = await mod.runReactionExport(env, noCtx, FIRST_OF_SEPT + 3600000);
      assert.deepEqual(again, { reason: "sent", month: LAST_MONTH, rows: 1, serious: 0 });
      assert.equal(
        calls.resend[0].headers["Idempotency-Key"],
        "reaction-export-2026-08",
        "same key, so a send that had landed is not duplicated"
      );
    });
    assert.equal(
      await state.getJobState(env.STATE_DB, REACTION_EXPORT_JOB),
      THIS_MONTH,
      "and now the month is closed"
    );
  });

  await it("a transport failure is send-failed too, logged as the transport message only", async () => {
    const env = await makeEnv();
    insertReport(env, report("YL-AE-AAAA-0001", AUG_START + 1000));
    const { value, logs } = await withMocks(
      () => captureLogs(() => mod.runReactionExport(env, noCtx, FIRST_OF_SEPT)),
      { transportFails: true }
    );
    assert.equal(value.reason, "send-failed");
    assert.match(logs, /failed to send: fetch failed: ECONNRESET/);
    for (const secret of REPORT_SECRETS)
      assert.ok(!logs.includes(secret), `no "${secret}" in the logs`);
    assert.notEqual(await state.getJobState(env.STATE_DB, REACTION_EXPORT_JOB), THIS_MONTH);
  });

  console.log(`\nworker-reaction-export.test.js: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("FAILED:\n  " + failures.join("\n  "));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
