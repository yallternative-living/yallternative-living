/**
 * @fileoverview The monthly adverse-event export: one CSV of last month's
 * reaction reports, emailed to the shop on the 1st.
 *
 * WHY A SHOP THIS SIZE NEEDS THIS
 * MoCRA makes the shop keep every adverse-event record (21 U.S.C. 364a(c)) --
 * three years at this shop's size, six above $1M in average annual sales -- and
 * report a SERIOUS one to the FDA within 15 business days. Those rows live in
 * D1, where nobody looks. This job is the monthly look: a file that lands in
 * the owner's mailbox saying "here is everything that came in last month, and
 * here is how many of them were serious".
 *
 * THE ZERO-ROW EMAIL IS THE POINT, NOT AN EDGE CASE.
 * When there were no reports the note still goes out, still with a (header-only)
 * file attached. An unbroken run of monthly files is evidence that the check
 * happened every month; a silent month is indistinguishable from a broken cron,
 * and "we thought it was running" is the answer nobody wants to give an
 * inspector.
 *
 * THIS IS NOT A MARKETING SEND.
 * It goes to the shop's own mailbox through `sendEmail`, not
 * `sendMarketingEmail`: it carries no unsubscribe link and is not checked
 * against `email_suppression`, because a legal record-keeping notice to
 * yourself is not something you opt out of. It is also the one email in this
 * Worker that carries an attachment.
 *
 * NOTHING FROM A REPORT IS EVER LOGGED.
 * The log lines here carry a month, a row count and a serious count. Not a
 * description, not a name, not an address -- the same rule
 * workers/routes/safety-report.js holds itself to, for the same reason: these
 * rows are health information about named people and Cloudflare's log tail is
 * not where they belong. The CSV exists in memory and in one email; the
 * attachment is never echoed anywhere else.
 *
 * NOTHING HERE DELETES A ROW. Exporting is not archiving. See the retention
 * note on `adverse_events` in workers/schema.sql.
 */

import { escapeHtml } from "./http.js";
import { ensureSchema } from "../state/migrations.js";
import { claimMonthly, nyClock, setJobState } from "../state/job-state.js";
import { loadSiteSettings } from "../state/site-data.js";
import { fromAddress, sendEmail } from "./gift-cards.js";
import { SHOP_TIMEZONE } from "./retention-emails.js";

/** The job's row in `job_state`, and the day of the month it runs on. */
export const REACTION_EXPORT_JOB = "reaction-export";
export const REACTION_EXPORT_DAY = 1;

/** Where the file goes when neither env var is set. */
export const DEFAULT_EXPORT_EMAIL = "contact@yallternativeliving.com";

/**
 * Every column of `adverse_events`, in the order workers/schema.sql declares
 * them. The export is deliberately COMPLETE: a partial file would have to be
 * chased back to the database the one time it matters, and a MedWatch 3500A
 * needs all of it.
 */
export const EXPORT_COLUMNS = [
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
];

/* ------------------------------------------------------------------- dates */

/**
 * The UTC instant of local midnight on `year-month-01` in `timeZone`.
 *
 * Two passes: guess the instant as if the wall clock were UTC, measure the
 * zone's offset AT that instant, correct, then measure again in case the
 * correction crossed a DST boundary. A month boundary is never mid-transition
 * (US changes happen at 2am on a Sunday), but the second pass costs nothing and
 * makes the helper safe to reuse.
 */
export function zonedMonthStart(monthKey, timeZone = SHOP_TIMEZONE) {
  const parts = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ""));
  if (!parts) return NaN;
  const guess = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, 1);
  const offsetAt = (ts) => {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    const p = {};
    for (const part of dtf.formatToParts(new Date(ts))) p[part.type] = part.value;
    const asUtc = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour) % 24,
      Number(p.minute),
      Number(p.second)
    );
    return asUtc - ts;
  };
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}

/** `2026-09` -> `2026-08`. Crosses the year. */
export function previousMonth(monthKey) {
  const parts = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ""));
  if (!parts) return "";
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  return `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
}

/** `2026-09` -> `2026-10`. */
function nextMonth(monthKey) {
  const parts = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ""));
  if (!parts) return "";
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/**
 * `[start, end)` in epoch ms for one New York calendar month. Half-open on
 * purpose: a report filed at 23:59:59.999 on the last day belongs to that
 * month, and one filed at 00:00:00.000 on the 1st belongs to the next.
 */
export function monthWindow(monthKey, timeZone = SHOP_TIMEZONE) {
  return {
    start: zonedMonthStart(monthKey, timeZone),
    end: zonedMonthStart(nextMonth(monthKey), timeZone)
  };
}

/** "August 2026", for the subject line and the body. */
export function monthLabel(monthKey, timeZone = SHOP_TIMEZONE) {
  const start = zonedMonthStart(monthKey, timeZone);
  if (!Number.isFinite(start)) return String(monthKey || "");
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "long",
    year: "numeric"
  }).format(new Date(start));
}

/* --------------------------------------------------------------------- CSV */

/**
 * RFC 4180 field quoting: a field is quoted when it contains a comma, a double
 * quote, a CR or an LF, and an embedded quote is doubled. A leading or trailing
 * space is quoted too, because a spreadsheet will otherwise eat it.
 *
 * FORMULA INJECTION. A cell that starts with `=`, `+`, `-` or `@` (or a tab
 * or CR, which some importers strip before looking) is EXECUTED by Excel,
 * LibreOffice and Sheets when the file is opened -- `=HYPERLINK(...)`,
 * `=cmd|' /C calc'!A0`, or simply `-2+3`. Every text column in this file is a
 * reporter's own words typed into the form on /safety, and the file is opened
 * on the owner's machine. A leading apostrophe makes the cell text (OWASP's
 * recommendation), and the cell is quoted so the apostrophe survives the trip.
 * Quoting alone is NOT enough: `"=1+1"` still evaluates.
 */
export function csvField(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (!text) return "";
  const formulaLead = /^[=+\-@\t\r]/.test(text);
  if (formulaLead) text = `'${text}`;
  const needsQuotes = formulaLead || /[",\r\n]/.test(text) || /^\s|\s$/.test(text);
  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * One row's value for one column.
 *
 * `outcomes` is stored as a JSON array (`["infection","doctor-visit"]`) because
 * that is what the route wrote; a spreadsheet reads that as line noise, so it
 * is flattened to `infection|doctor-visit`. Pipe, not comma: a comma inside a
 * CSV cell is legal but is exactly the thing a careless downstream reader gets
 * wrong. `created_at` is rendered as an ISO timestamp AND kept as the raw
 * epoch, so the file sorts correctly in every tool.
 */
export function csvValue(row, column) {
  const raw = row ? row[column] : undefined;
  if (column === "outcomes") {
    try {
      const parsed = JSON.parse(String(raw || "[]"));
      return Array.isArray(parsed) ? parsed.join("|") : String(raw || "");
    } catch {
      return String(raw === null || raw === undefined ? "" : raw);
    }
  }
  if (column === "created_at") {
    const ts = Number(raw);
    return Number.isFinite(ts) ? new Date(ts).toISOString() : String(raw || "");
  }
  return raw === null || raw === undefined ? "" : String(raw);
}

/**
 * The whole file: a header row plus one row per report, CRLF-terminated as RFC
 * 4180 asks. `created_at_ms` is appended after the ISO timestamp so the raw
 * value survives the round trip.
 */
export function buildCsv(rows) {
  const header = EXPORT_COLUMNS.concat(["created_at_ms"]);
  const lines = [header.map(csvField).join(",")];
  for (const row of Array.isArray(rows) ? rows : []) {
    const values = EXPORT_COLUMNS.map((c) => csvValue(row, c));
    values.push(String(row && row.created_at !== undefined ? row.created_at : ""));
    lines.push(values.map(csvField).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * UTF-8 base64, which is what Resend's `attachments[].content` wants.
 *
 * Encoded through TextEncoder rather than `btoa(text)` directly: `btoa` throws
 * on any character above U+00FF, and a reporter writing "it burned — badly"
 * would otherwise fail the whole export.
 */
export function toBase64(text) {
  const bytes = new TextEncoder().encode(String(text));
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/* ------------------------------------------------------------------- email */

/**
 * The covering note: one paragraph, a count, a serious count, and what to do
 * about a serious one. No report content -- that is what the attachment is for.
 */
export function exportEmailBody(label, total, serious) {
  const headline = total
    ? `${total} reaction report${total === 1 ? "" : "s"} came in during ${label}, ` +
      `${serious} of which ${serious === 1 ? "was" : "were"} serious by the MoCRA definition. ` +
      "The full file is attached; every column of every report is in it."
    : `No reaction reports came in during ${label}. The attached file is the empty ` +
      "month's record -- it is here so the run itself is on the record, not just its results.";

  const followUp = serious
    ? "A serious adverse event has to reach the FDA within 15 BUSINESS DAYS of the day " +
      "the shop learned of it, on Form FDA 3500A (MedWatch). Check that each of the serious " +
      "rows below has been filed."
    : "Keep the file with the others. These records are kept for at least three years.";

  const html =
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">' +
    `<h2>Reaction reports: ${escapeHtml(label)}</h2>` +
    `<p>${escapeHtml(headline)}</p><p>${escapeHtml(followUp)}</p></div>`;
  const text = `Reaction reports: ${label}\n\n${headline}\n\n${followUp}\n`;
  return { html, text };
}

/* --------------------------------------------------------------- the job */

/**
 * Emails last month's adverse-event export. Called hourly from the `scheduled`
 * handler in workers/checkout.js and gated three ways:
 *   1. `site.enableReactionExport` -- the CMS switch, checked first.
 *   2. `claimMonthly` on day 1, so this runs once per New York calendar month.
 *   3. A per-month Resend idempotency key, so even a re-claimed month cannot
 *      put two copies of the same file in the mailbox.
 *
 * A missing RESEND_API_KEY is a quiet skip with one log line, taken BEFORE the
 * monthly claim: claiming and then bailing would burn the month's marker and
 * mean the file never went out at all.
 *
 * @returns {Promise<{reason: string, month?: string, rows?: number, serious?: number}>}
 */
export async function runReactionExport(env, ctx, now = Date.now()) {
  const db = env && env.STATE_DB;
  if (!db) return { reason: "no-database" };

  const site = await loadSiteSettings(env, ctx);
  if (site.enableReactionExport === false) return { reason: "disabled" };

  const clock = nyClock(now);
  const month = previousMonth(clock.month);

  if (!env.RESEND_API_KEY) {
    console.log("reaction-export: RESEND_API_KEY is not set -- the monthly export was not sent");
    return { reason: "unconfigured", month };
  }

  await ensureSchema(db);
  if (!(await claimMonthly(db, REACTION_EXPORT_JOB, REACTION_EXPORT_DAY, now))) {
    return { reason: "already-ran", month };
  }

  const { start, end } = monthWindow(month);
  const query = await db
    .prepare(
      `SELECT ${EXPORT_COLUMNS.join(", ")} FROM adverse_events
        WHERE created_at >= ? AND created_at < ?
        ORDER BY created_at`
    )
    .bind(start, end)
    .all();
  const rows = (query && query.results) || [];
  const serious = rows.filter((r) => Number(r.serious) === 1).length;

  const label = monthLabel(month);
  const body = exportEmailBody(label, rows.length, serious);
  const to = env.SAFETY_REPORT_EMAIL || env.RESTOCK_NOTIFY_EMAIL || DEFAULT_EXPORT_EMAIL;
  // A BOM so a double-clicked file opens with its accents intact in Excel.
  const csv = `\uFEFF${buildCsv(rows)}`;

  let delivered = false;
  try {
    const res = await sendEmail(
      env,
      {
        from: fromAddress(env),
        to,
        subject: `Reaction reports: ${label} (${rows.length} report${rows.length === 1 ? "" : "s"}${serious ? `, ${serious} serious` : ""})`,
        html: body.html,
        text: body.text,
        attachments: [{ filename: `reaction-reports-${month}.csv`, content: toBase64(csv) }]
      },
      `reaction-export-${month}`
    );
    delivered = Boolean(res && res.ok);
    if (!delivered)
      console.error(`reaction-export: ${month} export refused (${res && res.status})`);
  } catch (err) {
    // The message, never the file: `err.message` is a transport string and no
    // report value is ever interpolated into it.
    console.error("reaction-export: the export failed to send:", err && err.message);
  }

  if (!delivered) {
    // Re-open the month. `claimMonthly` wrote this month's marker BEFORE the
    // send, so a refusal here would otherwise have burned the month: one
    // transient 5xx from Resend at 00:07 on the 1st and the file never went out
    // -- the silent month the header of this file says the job exists to rule
    // out. A marker that is not this month lets the next hourly tick try again,
    // and the per-month idempotency key above means a send that DID land
    // despite the error is not duplicated.
    await setJobState(db, REACTION_EXPORT_JOB, `${clock.month}:retry`, now);
  }

  // A month, two counts, a status word. Nothing from a report.
  console.log(
    `reaction-export: ${month} -> ${rows.length} rows, ${serious} serious, ` +
      `${delivered ? "sent" : "NOT sent"}`
  );
  return { reason: delivered ? "sent" : "send-failed", month, rows: rows.length, serious };
}
