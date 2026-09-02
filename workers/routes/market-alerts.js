/**
 * @fileoverview Market-date alerts: the events page's "email me the next
 * market date" signup, and the day-before reminder the cron sends from it.
 *
 *   POST /api/market-alerts   store a subscriber (JSON or a plain form post)
 *   runMarketReminders(env, ctx)  the hourly cron's once-a-day reminder pass
 *
 * WHY THIS IS NOT A KIT FORM ANY MORE
 * The form on events.html used to post straight to Kit with
 * `fields[interest]=events`, which meant the one thing it promised -- "the next
 * market date in your inbox" -- depended on somebody remembering to write a
 * Kit broadcast the night before every market. Nobody was ever going to. The
 * address now lands in `market_alert_subscribers` and this file's cron sends
 * the reminder itself, from the same events.json the page renders from.
 *
 * WHAT IS STORED, AND WHY THE SENTENCE IS STORED WITH IT
 * The address (lower-cased), when it arrived, and `consent_text` -- the EXACT
 * sentence the form showed at the moment they typed it. Consent is a record of
 * what someone was told, not a boolean: if the promise on the page is ever
 * reworded, every row still says what its own subscriber agreed to. That is
 * why CONSENT_TEXT below and the line rendered by `eventEmailCaptureHTML` in
 * assets/js/main.js are asserted equal by scripts/worker-market-alerts.test.js
 * -- if you change one, change the other.
 *
 * THE REMINDER IS A MARKETING SEND
 * It goes through `sendMarketingEmail`, like every other one, so it is checked
 * against `email_suppression` at send time and carries `List-Unsubscribe` +
 * `List-Unsubscribe-Post` (RFC 8058) and the visible opt-out line. There is no
 * separate unsubscribe list for market alerts: one opt-out stops everything.
 */

import { clientIp, escapeHtml, json, readJson } from "./http.js";
import { checkRateLimit } from "../state/rate-limit.js";
import { ensureSchema } from "../state/migrations.js";
import { claimDaily, nyClock, setJobState } from "../state/job-state.js";
import { hashEmail, normalizeEmail } from "../state/retention.js";
import { loadEvents, loadSiteSettings } from "../state/site-data.js";
import { retentionConfig, sendMarketingEmail, SHOP_TIMEZONE } from "./retention-emails.js";

export const MARKET_ALERT_RATE_LIMIT = { limit: 5, period: 60 };

/**
 * The sentence the form shows, stored verbatim on every row as `consent_text`.
 * assets/js/main.js renders this exact string under the input.
 */
export const CONSENT_TEXT = "One email the day before each market. Unsubscribe any time.";

/** The job's row in `job_state`. */
export const MARKET_REMINDER_JOB = "market-reminders";

/** `site.automations.marketReminderHour` when the CMS has no value. */
export const DEFAULT_REMINDER_HOUR = 9;

/**
 * How many reminders one cron tick will send.
 *
 * The cron fires hourly and `claimDaily` normally lets this job run once a
 * day. When a run hits this bound the day marker is rewritten to a `:partial`
 * value that is NOT today's date, so the next hourly tick re-claims and picks
 * up where this one stopped -- a list bigger than one batch drains across the
 * evening instead of being silently truncated. Subscribers already emailed for
 * the event are skipped by `last_event_id`, so the resumed run does not repeat
 * anyone.
 */
export const MARKET_REMINDER_BATCH = 50;

/** Copy used when `site.automations.marketReminderIntro` is empty. */
export const DEFAULT_REMINDER_INTRO =
  "Quick reminder that we'll have a table tomorrow. Come say hey.";

/* ------------------------------------------------------ POST /api/market-alerts */

/**
 * Body reader that accepts BOTH a JSON fetch and a plain HTML form post, so
 * the events-page form still works with JavaScript switched off. Same shape as
 * the reader in routes/retention.js and routes/safety-report.js.
 *
 * @returns {Promise<{data: object, isForm: boolean}>}
 */
async function readBody(request) {
  const type = String(request.headers.get("Content-Type") || "").toLowerCase();
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const form = await request.formData();
    const data = {};
    for (const [key, value] of form.entries()) data[key] = typeof value === "string" ? value : "";
    return { data, isForm: true };
  }
  return { data: await readJson(request, "Invalid request payload."), isForm: false };
}

/**
 * Stores one subscriber. Idempotent by primary key: a second signup from the
 * same address writes nothing and still reports success -- refreshing the page
 * must not look like a failure, and "you are already on this list" is not a
 * thing this endpoint is willing to tell an anonymous caller about someone
 * else's address.
 */
export async function handleMarketAlerts(request, env, origin) {
  const { data, isForm } = await readBody(request);
  const siteOrigin = (env && env.SITE_ORIGIN) || "https://yallternativeliving.com";

  const done = (payload, status) => {
    if (!isForm) return json(payload, status, origin, env);
    // No-JS fallback: the outcome travels in the query string and the hash
    // targets the form's own heading, so the browser lands back on it. The
    // address is NEVER put in the URL -- a URL ends up in logs and referrers.
    const state = payload && payload.ok ? "saved" : "error";
    return new Response(null, {
      status: 303,
      headers: {
        Location: `${siteOrigin}/events.html?market-alerts=${state}#eventsMarketAlertTitle`,
        "Cache-Control": "no-store"
      }
    });
  };

  // Silent honeypot, same shape as the restock, birthday and safety routes: a
  // bot that can tell it was caught is a bot that stops filling the field in.
  if (data.website_hp || data.events_alert_website) {
    return done({ ok: true, message: "You're on the list." }, 200);
  }

  let email;
  try {
    email = normalizeEmail(data.email || data.email_address);
  } catch {
    return done({ error: "Please enter a valid email address." }, 400);
  }

  const limit = await checkRateLimit(env, `market-alerts:${clientIp(request)}`, {
    ...MARKET_ALERT_RATE_LIMIT,
    failOpen: true
  });
  if (!limit.success) {
    return done({ error: "Too many requests. Please wait a minute and try again." }, 429);
  }

  if (!env.STATE_DB) {
    // Refusing to pretend, for the same reason the restock route does: a
    // signup "saved" nowhere is worse than an honest refusal, because the
    // person walks away believing they will be told about the next market.
    console.error("market-alerts: STATE_DB is not bound; signup NOT stored");
    return done({ error: "Market alerts are temporarily unavailable." }, 503);
  }

  try {
    await ensureSchema(env.STATE_DB);
    await env.STATE_DB.prepare(
      `INSERT OR IGNORE INTO market_alert_subscribers (email, created_at, consent_text)
       VALUES (?, ?, ?)`
    )
      .bind(email, Date.now(), CONSENT_TEXT)
      .run();
  } catch (err) {
    // The SQLite message, never the address.
    console.error("market-alerts: could not store the signup:", err && err.message);
    return done({ error: "We could not save that just now. Please try again shortly." }, 502);
  }

  return done(
    { ok: true, message: "You're on the list. We'll write the day before each market." },
    200
  );
}

/* ------------------------------------------------------- the day-before job */

/** Positive integer or the fallback. */
function intOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

/** `YYYY-MM-DD` plus `days`, by calendar arithmetic. Crosses months and years. */
export function addDays(day, days) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!parts) return "";
  const ms = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) + days * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The calendar day an event STARTS on, in the shop's timezone.
 *
 * `events.json` carries both spellings: a bare `"2026-08-29"` and a full
 * `"2026-10-17T09:00:00-04:00"`. A bare date is already a calendar day and is
 * taken as-is -- running it through `Date.parse` would read it as UTC midnight
 * and shift it a day backwards in New York, which is exactly the off-by-one
 * that would send a reminder for the wrong day.
 */
export function eventStartDay(event, timeZone = SHOP_TIMEZONE) {
  const raw = String((event && event.date) || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(ts));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Upcoming events that start on `day`, in calendar order, ids only. */
export function eventsStartingOn(events, day) {
  const list = (events && Array.isArray(events.upcoming) && events.upcoming) || [];
  return list.filter((ev) => ev && ev.id && eventStartDay(ev) === day);
}

/** The reminder itself. No discount, no urgency -- it is a date and a place. */
export function marketReminderEmail(event, intro, siteOrigin) {
  const name = String(event.name || "our next market");
  const when = String(event.dateLabel || eventStartDay(event) || "tomorrow");
  const where = String(event.location || "");
  const eventsUrl = `${siteOrigin}/events.html`;

  const detailRows = [["What", name], ["When", when], ...(where ? [["Where", where]] : [])];

  const html =
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; ' +
    'background: #17130f; color: #fff; padding: 32px; border-radius: 12px; border: 2px solid #d69b5c;">' +
    `<h1 style="color:#d69b5c;">${escapeHtml(name)} is tomorrow</h1>` +
    `<p>${escapeHtml(intro)}</p><table>` +
    detailRows
      .map(
        (r) =>
          `<tr><td style="padding-right:12px;"><strong>${escapeHtml(r[0])}</strong></td>` +
          `<td>${escapeHtml(r[1])}</td></tr>`
      )
      .join("") +
    "</table>" +
    `<p><a style="color:#d69b5c;" href="${escapeHtml(eventsUrl)}">See the full market calendar</a></p>` +
    "</div>";

  const text =
    `${name} is tomorrow\n\n${intro}\n\n` +
    detailRows.map((r) => `${r[0]}: ${r[1]}`).join("\n") +
    `\n\nThe full market calendar: ${eventsUrl}\n`;

  return { subject: `Tomorrow: ${name}`, html, text };
}

/**
 * Sends the day-before reminder for every market starting tomorrow.
 *
 * Called hourly by the `scheduled` handler in workers/checkout.js and gated
 * three ways:
 *   1. `site.enableMarketReminders` -- the CMS switch, checked first so
 *      turning it off in /admin really does stop the send.
 *   2. `claimDaily`, at `site.automations.marketReminderHour` New York, so the
 *      hourly cron sends one round of reminders a day and not twenty-four.
 *   3. `last_event_id` on each subscriber row, so a resumed batch (see
 *      MARKET_REMINDER_BATCH) never repeats anyone.
 *
 * Missing credentials are a quiet skip with ONE log line, taken BEFORE the
 * daily claim: claiming and then bailing would burn the day's marker and mean
 * nothing went out even after the secret was set.
 *
 * @returns {Promise<{reason: string, day?: string, events?: number, sent?: number,
 *                    skipped?: number, failed?: number, truncated?: boolean}>}
 */
export async function runMarketReminders(env, ctx, now = Date.now()) {
  const db = env && env.STATE_DB;
  if (!db) return { reason: "no-database" };

  const site = await loadSiteSettings(env, ctx);
  if (site.enableMarketReminders === false) return { reason: "disabled" };

  const automations =
    (site.automations && typeof site.automations === "object" && site.automations) || {};
  const hour = intOr(automations.marketReminderHour, DEFAULT_REMINDER_HOUR);
  const clock = nyClock(now);
  if (clock.hour < hour) return { reason: "too-early", day: clock.day };

  if (!env.MAGIC_LINK_SECRET || !env.RESEND_API_KEY) {
    // One line, no addresses. Without the signing secret no unsubscribe link
    // can be made, and sendMarketingEmail would refuse every send anyway.
    console.log(
      "market-reminders: MAGIC_LINK_SECRET or RESEND_API_KEY is not set -- no reminders sent"
    );
    return { reason: "unconfigured", day: clock.day };
  }

  await ensureSchema(db);
  const claimed = await claimDaily(db, MARKET_REMINDER_JOB, hour, now);
  if (!claimed) return { reason: "already-ran", day: clock.day };

  const tomorrow = addDays(clock.day, 1);
  const events = eventsStartingOn(await loadEvents(env, ctx), tomorrow);
  const result = {
    reason: "ran",
    day: clock.day,
    events: events.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    truncated: false
  };
  if (!events.length) return { ...result, reason: "no-market-tomorrow" };

  const config = retentionConfig(env);
  const intro = String(automations.marketReminderIntro || DEFAULT_REMINDER_INTRO).trim();
  let budget = MARKET_REMINDER_BATCH;

  for (const event of events) {
    if (budget <= 0) {
      // An event this run never reached at all.
      result.truncated = true;
      break;
    }
    const pending = await db
      .prepare(
        `SELECT email FROM market_alert_subscribers
          WHERE last_event_id IS NULL OR last_event_id <> ?
          ORDER BY created_at
          LIMIT ?`
      )
      // One row past the budget: enough to know there is more without counting
      // a list this job has no reason to count.
      .bind(event.id, budget + 1)
      .all();
    const rows = (pending && pending.results) || [];
    if (rows.length > budget) result.truncated = true;

    const message = marketReminderEmail(event, intro, config.siteOrigin);
    for (const row of rows.slice(0, budget)) {
      const hash = await hashEmail(row.email);
      let outcome;
      try {
        outcome = await sendMarketingEmail(env, db, {
          to: row.email,
          subject: message.subject,
          html: message.html,
          text: message.text,
          // The pair that makes a resumed batch safe: Resend refuses a second
          // send under the same key, so at worst a repeat is a no-op.
          idempotencyKey: `market-${event.id}-${hash}`
        });
      } catch (err) {
        outcome = { ok: false, reason: err && err.message };
      }
      budget--;
      if (outcome.ok) result.sent++;
      else if (outcome.skipped) result.skipped++;
      else {
        // A refusal from Resend is transient. The row is NOT marked, so the
        // next tick (or tomorrow morning's) tries again -- and the idempotency
        // key means a send that actually landed is not repeated.
        result.failed++;
        console.error(`market-reminders: send refused for ${hash} (${outcome.reason || "error"})`);
        continue;
      }
      await db
        .prepare(
          "UPDATE market_alert_subscribers SET last_event_id = ?, last_sent_at = ? WHERE email = ?"
        )
        .bind(event.id, now, row.email)
        .run();
      if (budget <= 0) break;
    }
  }

  if (result.truncated || result.failed) {
    // Hand the rest to the next hourly tick by making the day marker not-today:
    // the subscribers the budget did not reach, and the ones Resend refused
    // (their rows are unmarked, so the re-claimed run picks exactly them up).
    // Bounded by the day -- tomorrow's claim compares against a new date.
    await setJobState(db, MARKET_REMINDER_JOB, `${clock.day}:partial`, now);
  }
  // Counts and a day, never an address.
  console.log(
    `market-reminders: ${result.day} -> ${result.sent} sent, ${result.skipped} skipped, ` +
      `${result.failed} failed${result.truncated || result.failed ? ", more queued for the next tick" : ""}`
  );
  return result;
}
