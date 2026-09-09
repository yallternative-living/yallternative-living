/**
 * @fileoverview Owner alerts -- "something in the Worker broke, and a person
 * needs to know".
 *
 * Until this existed every failure in workers/ was a console.error into
 * Cloudflare's tail log, which is ephemeral and which nobody reads. A gift-card
 * unwind that could not expire its session, the sales-tax probe failing open to
 * no tax, a webhook handler throwing after it took the exactly-once claim, a
 * cron step dying every hour, a retention email given up on -- all of them
 * left a shopper or the shop's books wrong with no signal to the shop.
 *
 * `alertOwner` emails the shop through the same Resend helper every other
 * owner-facing email uses, and it is built to be safe to call from anywhere:
 *
 *   NEVER THROWS. Every await is inside a try/catch that degrades to a
 *     console.error carrying the same marker, so a broken alert can never be
 *     the reason a checkout or a webhook fails.
 *   NEVER BLOCKS. The work is handed to ctx.waitUntil (or simply detached when
 *     there is no ctx); the caller carries on and the money path does not wait
 *     on Resend.
 *   STORM-PROOF. One email per `key` per ALERT_WINDOW_MS (six hours). The
 *     claim is a single atomic upsert on the existing `job_state` table
 *     (job = "alert:<key>") whose WHERE clause only lets the row be taken when
 *     the previous send is older than the window, so two isolates racing on
 *     the same failure cannot both win. An in-memory memo in front of it saves
 *     the D1 query for the repeats within one isolate. Without D1 the memo is
 *     the only guard -- per isolate rather than global, which is still a cap.
 *   MASKED. Gift-card codes are stored value; the body only ever carries their
 *     last four characters.
 *
 * The recipient is `site.alertEmail` from content.json when the shop has set
 * one in the CMS (admin/config.yml, "Emails to me · Where shop alerts go"),
 * otherwise the same ladder the order digest walks: ORDER_NOTIFY_EMAIL ->
 * RESTOCK_NOTIFY_EMAIL -> the contact address.
 */

import { fromAddress, sendEmail } from "./gift-cards.js";
import { loadSiteSettings } from "../state/site-data.js";
import { ensureSchema } from "../state/migrations.js";

/** One email per key per this long. Six hours: long enough that an hourly cron
 *  failing all night is one email, short enough that a problem still on fire
 *  the next working day is mentioned again. */
export const ALERT_WINDOW_MS = 6 * 60 * 60 * 1000;

/** The string to search for in the Worker's log; every alert logs with it
 *  whether or not the email went out. */
export const LOG_MARKER = "owner-alert";

const DEFAULT_RECIPIENT = "contact@yallternativeliving.com";
const SUBJECT_PREFIX = "[Shop alert] ";
const JOB_PREFIX = "alert:";

/** Same shapes routes/gift-cards.js accepts (grouped, flat, and the minted
 *  YALL-/YALL-PTS- promotion codes), matched anywhere in free text. */
const CODE_RE = /\bYALL-(?:PTS-)?(?:[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}|[0-9A-Z]{6,16})\b/g;

/** Per-isolate "last sent" memo: key -> ms. */
let lastSent = new Map();

/** Test seam: forgets the isolate memo. */
export function resetAlertMemo() {
  lastSent = new Map();
}

/**
 * `YALL-AB12-CD34-EF56` -> `YALL-****-****-EF56`, and the same idea for the
 * flat and promotion-code shapes. Anything that is not a code comes back as is.
 */
export function maskGiftCardCode(value) {
  const text = String(value == null ? "" : value);
  return text.replace(CODE_RE, (code) => {
    const tail = code.slice(-4);
    return code.startsWith("YALL-PTS-") ? `YALL-PTS-****${tail}` : `YALL-****-****-${tail}`;
  });
}

function isEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** The env-only ladder, for callers that must not fetch anything. */
export function envAlertRecipient(env) {
  return (env && (env.ORDER_NOTIFY_EMAIL || env.RESTOCK_NOTIFY_EMAIL)) || DEFAULT_RECIPIENT;
}

/**
 * Where alerts go: the CMS field first, then the env ladder. Degrades to the
 * env ladder when content.json is unreachable -- an alert about the site being
 * down must not depend on the site being up.
 */
export async function alertRecipient(env, ctx) {
  let site = {};
  try {
    site = await loadSiteSettings(env, ctx);
  } catch {
    site = {};
  }
  const fromCms = site && site.alertEmail;
  return isEmail(fromCms) ? fromCms.trim() : envAlertRecipient(env);
}

/**
 * Takes the once-per-window slot for `key`. True when this call should send.
 *
 * Memo first (free), then the atomic D1 upsert. A D1 error is treated as
 * "unknown" and falls back to the memo alone, because losing the email is the
 * worse outcome; the memo is set either way so one isolate never storms.
 */
export async function claimAlertSlot(db, key, now = Date.now(), windowMs = ALERT_WINDOW_MS) {
  const previous = lastSent.get(key);
  if (previous !== undefined && now - previous < windowMs) return false;

  if (db) {
    try {
      await ensureSchema(db);
      const result = await db
        .prepare(
          "INSERT INTO job_state (job, value, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(job) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at " +
            "WHERE job_state.updated_at <= ?"
        )
        .bind(JOB_PREFIX + key, String(now), now, now - windowMs)
        .run();
      const changed = result && result.meta ? Number(result.meta.changes) : 1;
      if (changed < 1) {
        lastSent.set(key, now);
        return false;
      }
    } catch (err) {
      console.error(
        `${LOG_MARKER}: dedupe store unavailable, sending on memo alone:`,
        err && err.message
      );
    }
  }
  lastSent.set(key, now);
  return true;
}

function detailLines(details) {
  if (details == null) return [];
  if (typeof details === "string") return details.split("\n");
  if (typeof details !== "object") return [String(details)];
  return Object.keys(details)
    .filter((name) => details[name] !== undefined && details[name] !== null && details[name] !== "")
    .map((name) => `${name}: ${String(details[name])}`);
}

/**
 * The plain-text body. Exported so the test can pin the shape: what failed,
 * the ids, the time, the log marker to search for.
 */
export function formatAlertBody({ key, subject, details, now = Date.now(), workerName }) {
  const worker = workerName || "yallternative-checkout";
  const lines = [
    "Something in the shop's checkout Worker needs a look.",
    "",
    `What failed: ${subject}`,
    `When: ${new Date(now).toISOString()} (UTC)`,
    `Alert key: ${key}`,
    ""
  ];
  const detail = detailLines(details);
  if (detail.length) {
    lines.push("Details:");
    for (const line of detail) lines.push(`  ${line}`);
    lines.push("");
  }
  lines.push(
    `Where to look: Cloudflare -> Workers & Pages -> ${worker} -> Logs, ` +
      `and search for "${LOG_MARKER} ${key}".`,
    "",
    "This alert goes out at most once every six hours per problem, so the same " +
      "failure may have happened more than once since. If you are not sure what " +
      "to do, forward this email to Steven."
  );
  return maskGiftCardCode(lines.join("\n"));
}

async function deliver(env, ctx, { key, subject, details, now }) {
  const shouldSend = await claimAlertSlot(env && env.STATE_DB, key, now);
  if (!shouldSend) return { sent: false, reason: "deduped" };

  if (!env || !env.RESEND_API_KEY) {
    console.error(`${LOG_MARKER} ${key}: RESEND_API_KEY is not set; alert logged only`);
    return { sent: false, reason: "no-resend" };
  }

  const to = await alertRecipient(env, ctx);
  const text = formatAlertBody({ key, subject, details, now, workerName: undefined });
  const result = await sendEmail(env, {
    from: fromAddress(env),
    to,
    subject: SUBJECT_PREFIX + maskGiftCardCode(subject),
    text
  });
  if (!result.ok) {
    console.error(`${LOG_MARKER} ${key}: Resend refused the alert (${result.status})`);
    return { sent: false, reason: `resend-${result.status}` };
  }
  return { sent: true, to };
}

/**
 * Tell the shop something broke. Fire-and-forget: returns the settled promise
 * (for tests and callers that want the outcome) but never rejects, and the
 * work runs behind ctx.waitUntil when a ctx is given.
 *
 * @param {object} env the Worker env
 * @param {{waitUntil?: Function}|null} ctx the execution context, or null
 * @param {{key: string, subject: string, details?: object|string, now?: number}} alert
 *   `key` identifies the PROBLEM (not the occurrence) -- it is the dedupe unit
 *   and the thing to search the log for. `details` is a flat object of ids, or
 *   a string; gift-card codes in either are masked.
 * @returns {Promise<{sent: boolean, reason?: string, to?: string}>}
 */
export function alertOwner(env, ctx, alert) {
  const key = String((alert && alert.key) || "unknown").replace(/\s+/g, "-");
  const subject = String((alert && alert.subject) || "Something in the Worker failed");
  const details = alert ? alert.details : undefined;
  const now = alert && Number.isFinite(alert.now) ? alert.now : Date.now();

  // The log line is unconditional: it is the thing the email tells the
  // reader to search for, and the only record when email is unavailable.
  console.error(
    `${LOG_MARKER} ${key}: ${maskGiftCardCode(subject)}`,
    maskGiftCardCode(detailLines(details).join(" | "))
  );

  const work = deliver(env, ctx, { key, subject, details, now }).catch((err) => {
    console.error(`${LOG_MARKER} ${key}: could not email the alert:`, err && err.message);
    return { sent: false, reason: "threw" };
  });
  try {
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(work);
  } catch {
    // A ctx that refuses the promise still gets the detached work above.
  }
  return work;
}
