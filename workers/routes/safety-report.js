/**
 * @fileoverview POST /api/safety-report -- the MoCRA adverse-event intake.
 *
 * WHY THIS ROUTE EXISTS AT ALL
 * The Modernization of Cosmetics Regulation Act (MoCRA) requires a cosmetic
 * product label to carry a domestic address, phone number or electronic contact
 * through which a consumer can report an adverse event (21 U.S.C. 364a, FD&C
 * Act section 609(a)). This shop prints one URL on its packaging --
 * https://yallternativeliving.com/safety -- and safety.html is the page behind
 * it. This route is what that page posts to.
 *
 * WHAT THE FIELDS ARE FOR
 * They are the fields a MedWatch Form FDA 3500A report needs: what the person
 * used, which lot, where they got it, when they first used it, when the
 * reaction started, where on the body, what happened, what they did next, and
 * how to reach them. `serious` is computed HERE, never taken from the client:
 * a report is serious when it names death, a life-threatening reaction,
 * inpatient hospitalization, persistent or significant disability, a congenital
 * anomaly, an infection, significant disfigurement, or a medical or surgical
 * intervention to prevent one of those. A serious adverse event has to reach
 * the FDA within 15 BUSINESS DAYS of the day the shop learns of it, so the
 * owner's copy of the email says so in its subject and its first line.
 *
 * THREE YEARS, AND WHEN THAT BECOMES SIX
 * MoCRA's record-retention rule is six years (21 U.S.C. 364a(c)(2)), with a
 * three-year period for small businesses under section 612 -- under $1M in
 * average gross annual sales over the prior three years. Y'allternative Living
 * is under that threshold, so the retention period for everything written here
 * is THREE years.
 *
 * IF THE THREE-YEAR AVERAGE EVER CROSSES $1M, THE PERIOD BECOMES SIX YEARS.
 * Change RECORD_RETENTION_YEARS below, the note on `adverse_events` in
 * workers/schema.sql, the copy on safety.html and the paragraph in
 * privacy.html together -- and remember that rows already held under the
 * three-year rule are then held to the longer one too.
 *
 * Either way this is a MINIMUM, not a purge date. Nothing in this file, and
 * nothing in the cron, ever deletes an `adverse_events` row: keeping a record
 * longer than the law asks has never been the problem, and any future sweeper
 * must not treat this table like `webhook_events`.
 *
 * THE RECORD IS THE DATABASE ROW, NOT THE EMAIL
 * D1 is written FIRST. If that write fails the reporter is told the report did
 * not go through (503) rather than being thanked for a record that does not
 * exist -- the failure mode the restock route's header describes. If the row
 * lands and Resend then refuses, the caller still gets `{ ok: true }` and the
 * reference: the regulatory record exists and `email_status` on the row says
 * the owner has not been told yet, which is a thing to fix operationally, not
 * a reason to make the reporter type it all again.
 *
 * LOGGING
 * The description, the reporter's name, address and phone NEVER reach a log
 * line. Only the reference, the serious flag and a status word do. An adverse
 * event report is health information about a named person; Cloudflare's log
 * tail is not where it belongs.
 */

import { ClientError, clientIp, json, readJson, escapeHtml } from "./http.js";
import { checkRateLimit } from "../state/rate-limit.js";
import { ensureSchema } from "../state/migrations.js";
import { CODE_ALPHABET, fromAddress, sendEmail } from "./gift-cards.js";

export const SAFETY_REPORT_RATE_LIMIT = { limit: 5, period: 60 };
export const DEFAULT_SAFETY_EMAIL = "contact@yallternativeliving.com";

/** How long the row has to be kept, in years. Three under MoCRA's small-business
 *  rule (section 612: under $1M average gross annual sales over the prior three
 *  years); SIX if this shop's three-year average ever crosses $1M -- change this
 *  constant and the four places listed in the file header together if it does.
 *  It is a floor, not a purge date: nothing deletes these rows. */
export const RECORD_RETENTION_YEARS = 3;

/** The outcomes that make a report a "serious adverse event" under MoCRA. */
export const SERIOUS_OUTCOMES = [
  "death",
  "life-threatening",
  "hospitalization",
  "disability",
  "congenital-anomaly",
  "infection",
  "disfigurement",
  "intervention"
];

/** Everything else the form offers. Not serious on its own. */
export const OTHER_OUTCOMES = ["doctor-visit", "otc-product", "cleared-up"];

export const ALL_OUTCOMES = SERIOUS_OUTCOMES.concat(OTHER_OUTCOMES);

export const CHANNELS = ["site", "etsy", "in-person"];
export const AGE_RANGES = [
  "under-18",
  "18-24",
  "25-34",
  "35-44",
  "45-54",
  "55-64",
  "65-plus",
  "prefer-not-to-say"
];
export const SEXES = ["female", "male", "another-term", "prefer-not-to-say"];

const MAX_DESCRIPTION = 5000;
const MAX_NAME = 120;
const MAX_EMAIL = 254;
const MAX_PHONE = 40;
const MAX_LOT = 60;
const MAX_BODY_AREA = 200;
const MAX_PRODUCT_ID = 100;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Control characters (CR/LF included) never reach a header, subject or row. */
function clean(value) {
  return (
    String(value === null || value === undefined ? "" : value)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
      .trim()
  );
}

/** Single-line fields: newlines collapse too, so nothing can fake a field break. */
function line(value, max) {
  return clean(value).replace(/\s+/g, " ").slice(0, max);
}

/** The description keeps its paragraph breaks; only the control chars go. */
function block(value, max) {
  return clean(value).slice(0, max);
}

function pick(value, allowed) {
  const v = line(value, 40).toLowerCase();
  return allowed.indexOf(v) === -1 ? "" : v;
}

function truthy(value) {
  if (value === true) return true;
  const v = String(value === null || value === undefined ? "" : value)
    .trim()
    .toLowerCase();
  return v === "true" || v === "yes" || v === "on" || v === "1";
}

/**
 * `YL-AE-XXXX-XXXX` over the same Crockford base32 alphabet the gift-card codes
 * use -- no I/L/O/U, so a reference read back over the phone cannot be
 * mistyped. 8 symbols over 32 is 32^8 ~= 1.1e12: this is a lookup handle for a
 * report the shop already has, not a secret, but it should not collide.
 */
export function safetyReference(getRandomValues) {
  const rng = getRandomValues || ((array) => crypto.getRandomValues(array));
  const bytes = new Uint8Array(8);
  rng(bytes);
  let out = "";
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `YL-AE-${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

/** A one-way, salted handle for the submitting IP. The IP itself is not stored. */
async function hashIp(env, ip) {
  const salt = (env && env.MAGIC_LINK_SECRET) || "yl-adverse-event";
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/**
 * Body reader that accepts BOTH a JSON fetch and a plain HTML form post, so the
 * form on safety.html still works with JavaScript switched off. Same shape as
 * the retention routes' reader; checkboxes arrive repeated, so `getAll` is used
 * for the ones that can.
 *
 * @returns {Promise<{data: object, outcomes: string[], isForm: boolean}>}
 */
async function readBody(request) {
  const type = String(request.headers.get("Content-Type") || "").toLowerCase();
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const form = await request.formData();
    const data = {};
    for (const [key, value] of form.entries()) data[key] = typeof value === "string" ? value : "";
    const outcomes = form.getAll("outcomes").filter((v) => typeof v === "string");
    return { data, outcomes, isForm: true };
  }
  const data = await readJson(request, "Invalid request payload.");
  const outcomes = Array.isArray(data.outcomes) ? data.outcomes : [];
  return { data, outcomes, isForm: false };
}

/**
 * Validate and bound every field. Returns the row that will be written, or
 * throws a ClientError whose message the reporter is allowed to read.
 */
export function normalizeReport(data, rawOutcomes) {
  const email = line(data.email, MAX_EMAIL).toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    throw new ClientError("Please give an email address we can reach you at.");
  }

  const description = block(data.description, MAX_DESCRIPTION);
  if (description.length < 2) {
    throw new ClientError("Please describe what happened, in your own words.");
  }

  const dates = {};
  [
    ["first_use_date", data.first_use_date || data.firstUseDate],
    ["reaction_date", data.reaction_date || data.reactionDate]
  ].forEach(function (pair) {
    const value = line(pair[1], 10);
    if (!value) {
      dates[pair[0]] = "";
      return;
    }
    if (!DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
      throw new ClientError("Please give dates as YYYY-MM-DD, or leave them blank.");
    }
    dates[pair[0]] = value;
  });

  const outcomes = [];
  (Array.isArray(rawOutcomes) ? rawOutcomes : []).forEach(function (value) {
    const v = line(value, 40).toLowerCase();
    if (ALL_OUTCOMES.indexOf(v) !== -1 && outcomes.indexOf(v) === -1) outcomes.push(v);
  });

  const stoppedUse = pick(data.stopped_use || data.stoppedUse, ["yes", "no"]);

  return {
    product_id: line(data.product_id || data.product || data.productId, MAX_PRODUCT_ID),
    lot: line(data.lot, MAX_LOT),
    channel: pick(data.channel, CHANNELS),
    first_use_date: dates.first_use_date,
    reaction_date: dates.reaction_date,
    body_area: line(data.body_area || data.bodyArea, MAX_BODY_AREA),
    description,
    outcomes,
    // Computed here and only here. A client that posts `serious: true` changes
    // nothing; a client that omits an outcome cannot hide one it did send.
    serious: outcomes.some((o) => SERIOUS_OUTCOMES.indexOf(o) !== -1),
    stopped_use: stoppedUse,
    reporter_name: line(data.reporter_name || data.name, MAX_NAME),
    reporter_email: email,
    reporter_phone: line(data.reporter_phone || data.phone, MAX_PHONE),
    age_range: pick(data.age_range || data.ageRange, AGE_RANGES),
    sex: pick(data.sex, SEXES),
    contact_consent: truthy(data.contact_consent || data.contactConsent)
  };
}

const OUTCOME_LABELS = {
  death: "Death",
  "life-threatening": "Life-threatening reaction",
  hospitalization: "Inpatient hospitalization",
  disability: "Persistent or significant disability",
  "congenital-anomaly": "Congenital anomaly or birth defect",
  infection: "Infection",
  disfigurement: "Significant disfigurement",
  intervention: "A medical or surgical procedure to prevent one of the above",
  "doctor-visit": "Saw a doctor or urgent care",
  "otc-product": "Used an over-the-counter product",
  "cleared-up": "Nothing -- it cleared up"
};

const CHANNEL_LABELS = {
  site: "yallternativeliving.com",
  etsy: "Etsy",
  "in-person": "In person (market or event)"
};

/** The owner's copy: every field, plus the clock when it is serious. */
export function ownerEmailBody(row, reference) {
  const rows = [
    ["Reference", reference],
    ["Received", new Date(row.created_at).toISOString()],
    ["Product", row.product_id || "not given"],
    ["Lot / batch", row.lot || "not given"],
    ["Bought from", CHANNEL_LABELS[row.channel] || "not given"],
    ["First used", row.first_use_date || "not given"],
    ["Reaction started", row.reaction_date || "not given"],
    ["Where on the body", row.body_area || "not given"],
    [
      "What happened next",
      row.outcomes.length ? row.outcomes.map((o) => OUTCOME_LABELS[o] || o).join("; ") : "not given"
    ],
    ["Stopped using it", row.stopped_use || "not given"],
    ["Reporter", row.reporter_name || "not given"],
    ["Email", row.reporter_email],
    ["Phone", row.reporter_phone || "not given"],
    ["Age range", row.age_range || "not given"],
    ["Sex", row.sex || "not given"],
    ["May we follow up?", row.contact_consent ? "Yes" : "No"]
  ];

  const clock = row.serious
    ? `<p style="font-weight:bold">SERIOUS ADVERSE EVENT. Under MoCRA this has to be reported to the FDA within 15 BUSINESS DAYS of today, on Form FDA 3500A (MedWatch). Keep this record for at least ${RECORD_RETENTION_YEARS} years.</p>`
    : `<p>Not a serious adverse event by the MoCRA definition. Keep the record for at least ${RECORD_RETENTION_YEARS} years.</p>`;

  const clockText = row.serious
    ? `SERIOUS ADVERSE EVENT. Under MoCRA this has to be reported to the FDA within 15 BUSINESS DAYS of today, on Form FDA 3500A (MedWatch). Keep this record for at least ${RECORD_RETENTION_YEARS} years.`
    : `Not a serious adverse event by the MoCRA definition. Keep the record for at least ${RECORD_RETENTION_YEARS} years.`;

  const html =
    `<h2>Reaction report ${escapeHtml(reference)}</h2>${clock}<table>` +
    rows
      .map((r) => `<tr><td><strong>${escapeHtml(r[0])}</strong></td><td>${escapeHtml(r[1])}</td></tr>`)
      .join("") +
    "</table><h3>In their words</h3><p>" +
    escapeHtml(row.description).replace(/\n/g, "<br>") +
    "</p>";

  const text =
    `Reaction report ${reference}\n\n${clockText}\n\n` +
    rows.map((r) => `${r[0]}: ${r[1]}`).join("\n") +
    `\n\nIn their words:\n${row.description}\n`;

  return { html, text };
}

/** The reporter's copy: an acknowledgement and the reference. Nothing else. */
export function reporterEmailBody(reference) {
  const html =
    "<p>Thanks for telling us. Your report is logged.</p>" +
    `<p>Your reference number is <strong>${escapeHtml(reference)}</strong>. Keep it -- ` +
    "quote it if you write to us again about this.</p>" +
    "<p>A person reads every one of these. If you said we could follow up, we may write " +
    "with a question or two. If your symptoms get worse, please see a doctor -- we are a " +
    "small handmade shop, not a medical service.</p>" +
    "<p>-- Y'allternative Living, Landrum, SC</p>";
  const text =
    "Thanks for telling us. Your report is logged.\n\n" +
    `Your reference number is ${reference}. Keep it -- quote it if you write to us again ` +
    "about this.\n\nA person reads every one of these. If you said we could follow up, we " +
    "may write with a question or two. If your symptoms get worse, please see a doctor -- " +
    "we are a small handmade shop, not a medical service.\n\n-- Y'allternative Living, Landrum, SC\n";
  return { html, text };
}

export async function handleSafetyReport(request, env, origin) {
  const { data, outcomes: rawOutcomes, isForm } = await readBody(request);
  const siteOrigin = (env && env.SITE_ORIGIN) || "https://yallternativeliving.com";

  const done = (payload, status) => {
    if (!isForm) return json(payload, status, origin, env);
    // No-JS fallback: a 303 back to the page carries the outcome in the query
    // string. The reference is an opaque handle, not personal data, so it is
    // safe in a URL -- nothing else from the form ever goes there.
    const query = payload && payload.ok ? `report=received&ref=${payload.reference}` : "report=error";
    return new Response(null, {
      status: 303,
      headers: {
        Location: `${siteOrigin}/safety.html?${query}#reaction-report`,
        "Cache-Control": "no-store"
      }
    });
  };

  // Silent honeypot, same shape as the restock and birthday routes: a bot that
  // can tell it was caught is a bot that stops filling the field in.
  if (data.website_hp || data.safety_hp) {
    return done({ ok: true, reference: safetyReference() }, 200);
  }

  let row;
  try {
    row = normalizeReport(data, rawOutcomes);
  } catch (err) {
    if (err instanceof ClientError && isForm) return done({ error: err.message }, err.status || 400);
    throw err;
  }

  const limit = await checkRateLimit(env, `safety-report:${clientIp(request)}`, {
    ...SAFETY_REPORT_RATE_LIMIT,
    failOpen: true
  });
  if (!limit.success) {
    return done(
      { error: "Too many reports from this connection. Please wait a minute and try again." },
      429
    );
  }

  if (!env.STATE_DB) {
    // Refusing to pretend. A reaction report that is "received" into nowhere is
    // the one outcome this page must never produce.
    console.error("safety-report: STATE_DB is not bound; report NOT stored");
    return done(
      {
        error:
          "We could not file that report just now. Please email " +
          DEFAULT_SAFETY_EMAIL +
          " so it does not get lost."
      },
      503
    );
  }

  const reference = safetyReference();
  row.created_at = Date.now();
  const ipHash = await hashIp(env, clientIp(request));

  try {
    await ensureSchema(env.STATE_DB);
    await env.STATE_DB.prepare(
      `INSERT INTO adverse_events (
         id, created_at, product_id, lot, channel, first_use_date, reaction_date,
         body_area, description, outcomes, stopped_use, reporter_name, reporter_email,
         reporter_phone, age_range, sex, contact_consent, serious, status, ip_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        reference,
        row.created_at,
        row.product_id,
        row.lot,
        row.channel,
        row.first_use_date,
        row.reaction_date,
        row.body_area,
        row.description,
        JSON.stringify(row.outcomes),
        row.stopped_use,
        row.reporter_name,
        row.reporter_email,
        row.reporter_phone,
        row.age_range,
        row.sex,
        row.contact_consent ? 1 : 0,
        row.serious ? 1 : 0,
        "new",
        ipHash
      )
      .run();
  } catch (err) {
    // The message, not the report: `err.message` is a SQLite string, and the
    // values that went into the statement are never interpolated into it.
    console.error("safety-report: could not store the report:", err && err.message);
    return done(
      {
        error:
          "We could not file that report just now. Please email " +
          DEFAULT_SAFETY_EMAIL +
          " so it does not get lost."
      },
      503
    );
  }

  // The row is the record. Email is how the owner finds out about it, and a
  // refusal from Resend does not un-file a report -- so from here on every
  // failure is logged (reference and status only) and the caller still gets ok.
  const to = env.SAFETY_REPORT_EMAIL || env.RESTOCK_NOTIFY_EMAIL || DEFAULT_SAFETY_EMAIL;
  const from = fromAddress(env);
  const subject = `${row.serious ? "SERIOUS -- " : ""}Reaction report ${reference}`;

  if (!env.RESEND_API_KEY) {
    console.error(`safety-report: ${reference} stored, but RESEND_API_KEY is unset -- not emailed`);
    return done({ ok: true, reference }, 200);
  }

  const owner = ownerEmailBody(row, reference);
  try {
    const res = await sendEmail(
      env,
      {
        from,
        to,
        reply_to: row.reporter_email,
        subject,
        html: owner.html,
        text: owner.text
      },
      `safety-owner-${reference}`
    );
    if (!res.ok) console.error(`safety-report: ${reference} owner notice refused (${res.status})`);
  } catch {
    console.error(`safety-report: ${reference} owner notice failed to send`);
  }

  const ack = reporterEmailBody(reference);
  try {
    const res = await sendEmail(
      env,
      {
        from,
        to: row.reporter_email,
        subject: `We got your report (${reference})`,
        html: ack.html,
        text: ack.text
      },
      `safety-ack-${reference}`
    );
    if (!res.ok) console.error(`safety-report: ${reference} acknowledgement refused (${res.status})`);
  } catch {
    console.error(`safety-report: ${reference} acknowledgement failed to send`);
  }

  return done({ ok: true, reference }, 200);
}
