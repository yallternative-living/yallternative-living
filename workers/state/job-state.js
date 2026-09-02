/**
 * @fileoverview job_state -- "when did this scheduled job last run" markers.
 *
 * The Worker's cron fires hourly (wrangler.toml [triggers]). Jobs that must
 * run once a day (order digest, low-stock check, market reminders) or once a
 * month (reaction export) record the New York calendar day or month they last
 * ran here and skip when it has not changed. Deliberately not a lock: two
 * overlapping cron invocations are rare and every job is idempotent on its
 * own (email idempotency keys, notified_at flags).
 */

export async function getJobState(db, job) {
  if (!db) return null;
  const row = await db.prepare("SELECT value FROM job_state WHERE job = ?").bind(job).first();
  return row ? String(row.value) : null;
}

export async function setJobState(db, job, value, now = Date.now()) {
  if (!db) return;
  await db
    .prepare(
      "INSERT INTO job_state (job, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(job) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .bind(job, String(value), now)
    .run();
}

/** Calendar day in America/New_York as YYYY-MM-DD, plus the local hour. */
export function nyClock(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit"
  }).formatToParts(new Date(now));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const hour = Number(get("hour")) % 24;
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    month: `${get("year")}-${get("month")}`,
    hour
  };
}

/**
 * True (and records the run) when `job` has not yet run on the current NY
 * day and the local hour has reached `hour`. Call it at the top of a daily
 * job; do the work only when it returns true.
 */
export async function claimDaily(db, job, hour, now = Date.now()) {
  const clock = nyClock(now);
  if (clock.hour < (Number(hour) || 0)) return false;
  const last = await getJobState(db, job);
  if (last === clock.day) return false;
  await setJobState(db, job, clock.day, now);
  return true;
}

/** Monthly variant: runs once per NY calendar month, on or after `dayOfMonth`. */
export async function claimMonthly(db, job, dayOfMonth, now = Date.now()) {
  const clock = nyClock(now);
  const day = Number(clock.day.slice(-2));
  if (day < (Number(dayOfMonth) || 1)) return false;
  const last = await getJobState(db, job);
  if (last === clock.month) return false;
  await setJobState(db, job, clock.month, now);
  return true;
}
