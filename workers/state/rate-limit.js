/**
 * @fileoverview Rate limiting with two backends: Cloudflare's free Rate Limiting
 * binding when it is available, and an exact Durable Object counter when it is not.
 *
 * WHY
 * Every public money-adjacent endpoint in the audit is unthrottled: C-1
 * (points redemption, "no rate limit"), the Medium/Payments note that the
 * gift-card balance endpoint is "an unthrottled validation oracle" over a ~1e9
 * code space, and `submit-restock.js`, which claims rate limiting it does not
 * have. Order status (H-6) becomes an enumeration oracle the moment it does a
 * real lookup. All of them need a limiter before they ship.
 *
 * TWO BACKENDS, AND WHY BOTH
 *
 * 1. `env.RATE_LIMITER` -- the Workers Rate Limiting binding. Free, no storage,
 *    no per-request billing. Its limits are enforced PER CLOUDFLARE LOCATION,
 *    not globally, and the docs describe it as best-effort: a distributed
 *    attacker spread across many colos gets roughly limit x colos. Its window is
 *    also fixed at 10 or 60 seconds and is configured in wrangler.toml, not per
 *    call -- so `limit`/`period` passed here are ignored on this path. Good
 *    enough for shaping abusive traffic, not a correctness boundary.
 *
 * 2. `RateLimitCounter` -- a SQLite Durable Object, one object per key. Exact
 *    and global, because every request for a key lands on the same object. It
 *    costs one DO request per check, which counts against the free plan's
 *    100k/day, so use it only where exactness matters (spending points, burning
 *    a magic link) and let the binding handle the noisy public reads.
 *
 * Neither backend is a substitute for the real fix. A limiter slows an oracle
 * down; it does not make guessing a gift-card code safe.
 *
 * FAILURE MODE
 * With no backend configured, `checkRateLimit` fails OPEN by default and says so
 * in `source: "none"`. A misconfigured binding must not take checkout offline.
 * Pass `failOpen: false` on endpoints where refusing is safer than serving.
 */

/** Fixed-window counters older than this many windows are dropped by the alarm. */
const WINDOW_RETENTION = 2;

const COUNTER_SCHEMA = `CREATE TABLE IF NOT EXISTS windows (
    window_start INTEGER PRIMARY KEY,
    hits         INTEGER NOT NULL
  )`;

/**
 * @param {object} env Worker bindings
 * @param {string} key what to limit on -- an IP, an email, an IP+route pair
 * @param {{limit: number, period: number, failOpen?: boolean, binding?: string,
 *          namespace?: string, now?: number}} options
 *   `period` is in seconds and applies to the Durable Object path only.
 * @returns {Promise<{success: boolean, source: 'binding'|'durable-object'|'none',
 *   remaining?: number, resetAt?: number}>}
 */
export async function checkRateLimit(env, key, options = {}) {
  const limit = Number(options.limit);
  const period = Number(options.period);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError("rate-limit: limit must be a positive integer.");
  }
  if (!Number.isInteger(period) || period < 1) {
    throw new TypeError("rate-limit: period must be a positive number of seconds.");
  }
  const cleanKey = String(key || "").slice(0, 255);
  if (!cleanKey) throw new TypeError("rate-limit: key is required.");

  const bindingName = options.binding || "RATE_LIMITER";
  const binding = env && env[bindingName];
  if (binding && typeof binding.limit === "function") {
    const outcome = await binding.limit({ key: cleanKey });
    return { success: outcome ? outcome.success !== false : true, source: "binding" };
  }

  const namespaceName = options.namespace || "RATE_LIMIT_COUNTER";
  const ns = env && env[namespaceName];
  if (ns && typeof ns.idFromName === "function") {
    const stub = ns.get(ns.idFromName(`${period}:${limit}:${cleanKey}`));
    const res = await stub.fetch("https://rate-limit/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit, period })
    });
    const body = await res.json();
    return { ...body, source: "durable-object" };
  }

  return { success: options.failOpen === false ? false : true, source: "none" };
}

/**
 * Exact fixed-window counter. One object per (period, limit, key) triple, so the
 * count is global rather than per-location.
 *
 * Fixed window, not sliding: a sliding window needs a row per request, and rows
 * written are the metered resource on the free plan. The known trade-off is that
 * up to 2x`limit` requests can land across a window boundary. For "10 gift-card
 * lookups a minute" that is irrelevant; for anything finer, lower the limit.
 */
export class RateLimitCounter {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(COUNTER_SCHEMA);
  }

  /**
   * @param {{limit: number, period: number, now?: number}} args
   * @returns {Promise<{success: boolean, remaining: number, resetAt: number}>}
   */
  async check(args) {
    const params = args || {};
    const limit = Number(params.limit);
    const period = Number(params.period);
    const now = Number(params.now) || Date.now();
    const periodMs = period * 1000;
    const windowStart = Math.floor(now / periodMs) * periodMs;

    const outcome = this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM windows WHERE window_start < ?", windowStart);
      this.sql.exec(
        `INSERT INTO windows (window_start, hits) VALUES (?, 1)
         ON CONFLICT(window_start) DO UPDATE SET hits = hits + 1`,
        windowStart
      );
      const hits = this.sql
        .exec("SELECT hits FROM windows WHERE window_start = ?", windowStart)
        .toArray()[0].hits;
      return {
        success: hits <= limit,
        remaining: Math.max(0, limit - hits),
        resetAt: windowStart + periodMs
      };
    });

    // Let the object evict itself once the window is well past, so an idle key
    // stops occupying storage (and stops being a cost) without a cron.
    await this.ctx.storage.setAlarm(windowStart + periodMs * WINDOW_RETENTION);
    return outcome;
  }

  /** Drops expired windows and deletes the object's storage when nothing is left. */
  async alarm() {
    const now = Date.now();
    this.sql.exec("DELETE FROM windows WHERE window_start < ?", now);
    const remaining = this.sql.exec("SELECT COUNT(*) AS n FROM windows").toArray()[0].n;
    if (remaining === 0 && typeof this.ctx.storage.deleteAll === "function") {
      await this.ctx.storage.deleteAll();
    }
  }

  async fetch(request) {
    const args = await request.json().catch(() => ({}));
    const result = await this.check(args);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }
}
