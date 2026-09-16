/**
 * @fileoverview The owner's fulfilment dashboard (admin/fulfillment.html):
 * list the orders still marked `processing` in D1, and push a shipped status
 * plus tracking link onto the Stripe PaymentIntent, exactly as typing it into
 * the Stripe Dashboard would. The hourly ship-notice sweep then emails the
 * customer and merges the status into D1 (routes/ship-notice.js).
 *
 * AUTH: the owner's own GitHub sign-in -- the same one Sveltia CMS already
 * uses at /admin/. The dashboard reads the token Sveltia stored
 * (localStorage `sveltia-cms.user`, field `token`) and sends it as
 * `Authorization: Bearer <gho_...>`; this Worker asks GitHub who that token
 * belongs to and whether they may push to the shop's repository.
 *
 * There is NO shared password. There used to be (`ADMIN_PASSWORD`), and a
 * shared secret on a public endpoint is guessable no matter how carefully it
 * is compared -- so it is gone rather than kept as a fallback, because a
 * fallback would have been the weakest link and the only one worth attacking.
 *
 * Why `GET /repos/{owner}/{repo}` and `permissions.push`: the repository is
 * PUBLIC, so any signed-in stranger's token also gets a 200 from that call --
 * with `permissions.push === false`. The push bit, not the status code, is
 * what separates the shop's owner from the rest of GitHub. One call, and the
 * `public_repo` scope the CMS already asks for covers it.
 *
 * Every request is still counted in ONE GLOBAL bucket, but the limiter is no
 * longer the security boundary: a `gho_` token is not something you guess, so
 * the bucket exists to cap what an anonymous caller can cost us in GitHub API
 * calls and Worker time. It therefore fails OPEN, like every shopper-facing
 * limiter here -- locking the owner out of shipping to protect a credential
 * that cannot be brute-forced would be the wrong trade. Tokens that do not
 * even look like GitHub tokens are refused before any network call, and both
 * verdicts are cached briefly, so a flood costs GitHub nothing.
 */

import { json, ClientError, readJson } from "./http.js";
import { checkRateLimit } from "../state/rate-limit.js";
import { stripePost } from "./stripe.js";
import { emailForHash } from "../state/orders.js";
import { SHIPPED_STATUSES } from "./ship-notice.js";
import { safeUrl } from "../state/stripe-orders.js";

/**
 * Requests per minute across BOTH admin routes together, all callers in one
 * bucket. Thirty covers a Saturday after a market (one page load plus a
 * "Mark Shipped" click per order). The key is a constant on purpose: on the
 * workers.dev hostname a caller picks its own X-Forwarded-For, so a per-IP
 * bucket would be per-attacker-string (routes/http.js clientIp()).
 */
export const ADMIN_AUTH_RATE_LIMIT = { limit: 30, period: 60 };
const ADMIN_AUTH_RATE_KEY = "admin-auth";

/** The repository whose push access grants the dashboard. Overridable per env. */
const DEFAULT_GITHUB_REPO = "yallternative-living/yallternative-living";

/**
 * GitHub token shapes (docs: "about authentication to GitHub"). `gho_` is what
 * the CMS OAuth flow mints; the others are accepted so a maintainer can use a
 * personal access token by hand. Anything else never reaches api.github.com.
 */
const GITHUB_TOKEN_RE = /^(?:gho|ghp|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,255}$/;

/** How long a verified (or rejected) token is trusted without asking GitHub again. */
const TOKEN_CACHE_MS = 5 * 60 * 1000;

/**
 * token digest -> { ok, login, expires }. Per-isolate and therefore
 * best-effort: a cold isolate just asks GitHub again. It exists so one
 * dashboard session (a list plus a dozen "Mark Shipped" clicks) costs a
 * single API call, and so a flood of the same bad token costs none.
 */
const tokenCache = new Map();

/**
 * What the dashboard may write as `fulfillment_status`: the words the
 * ship-notice sweep and order-status.html understand, nothing else. Undoing
 * a shipment is done in the Stripe Dashboard, where the metadata lives.
 */
export const FULFILLMENT_STATUSES = [...SHIPPED_STATUSES];

/** Stripe PaymentIntent ids: `pi_` + alphanumerics. Anything else is not a path segment. */
const PAYMENT_INTENT_RE = /^pi_[A-Za-z0-9]{1,255}$/;

/** Matches the `tracking_url` column budget in state/orders.js and safeUrl(). */
const TRACKING_URL_MAX = 500;

const encoder = new TextEncoder();

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  return auth.replace(/^Bearer\s+/i, "").trim();
}

function repoOf(env) {
  return (
    (env && typeof env.GITHUB_REPO === "string" && env.GITHUB_REPO.trim()) || DEFAULT_GITHUB_REPO
  );
}

/**
 * Ask GitHub whether this token may push to the shop's repository.
 *
 * @returns {Promise<{ok: boolean, status: number, login: string}>}
 *   `ok` true only when GitHub reports push access. `status` is what the
 *   caller should answer: 401 for a token GitHub will not accept, 403 for a
 *   real account without push, 503 when GitHub itself could not be reached.
 */
async function verifyGitHubPush(token, env) {
  const res = await fetch(`https://api.github.com/repos/${repoOf(env)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      // api.github.com rejects a request with no User-Agent outright.
      "User-Agent": "yallternative-fulfillment"
    }
  });
  if (res.status === 401) return { ok: false, status: 401, login: "" };
  if (!res.ok) {
    // 403 here is OUR problem (rate limit, bad User-Agent), not the caller's
    // permissions -- a stranger's token gets 200 with push:false instead.
    console.error(`fulfillment: GitHub refused the permission check (${res.status})`);
    return { ok: false, status: res.status === 404 ? 401 : 503, login: "" };
  }
  const body = await res.json().catch(() => null);
  const perms = body && body.permissions;
  const login = (body && body.owner && body.owner.login) || "";
  // Defensive: absent `permissions` is treated as no permission, never as yes.
  if (!perms || perms.push !== true) return { ok: false, status: 403, login };
  return { ok: true, status: 200, login };
}

/**
 * The bearer token, checked for shape, then against GitHub, then cached.
 * @returns {Promise<{ok: boolean, status: number}>}
 */
async function verifyAdminAuth(request, env, now = Date.now()) {
  const token = bearerToken(request);
  if (!token || !GITHUB_TOKEN_RE.test(token)) return { ok: false, status: 401 };

  const key = await sha256Hex(token);
  const hit = tokenCache.get(key);
  if (hit && hit.expires > now) return { ok: hit.ok, status: hit.status };

  const result = await verifyGitHubPush(token, env);
  // A 503 is about GitHub, not about this token, so it is never cached.
  if (result.status !== 503) {
    tokenCache.set(key, { ok: result.ok, status: result.status, expires: now + TOKEN_CACHE_MS });
    if (tokenCache.size > 64) {
      for (const [k, v] of tokenCache) if (v.expires <= now) tokenCache.delete(k);
    }
  }
  return { ok: result.ok, status: result.status };
}

/**
 * The limiter, then the GitHub check. Returns a Response to send when the
 * caller is refused, or null when they may proceed.
 */
async function gate(request, env, origin) {
  const limit = await checkRateLimit(env, ADMIN_AUTH_RATE_KEY, {
    ...ADMIN_AUTH_RATE_LIMIT,
    // Fails OPEN: the credential is a GitHub token, not a guessable secret,
    // so this bucket is cost control and must not lock the owner out.
    failOpen: true
  });
  if (!limit.success) {
    return json(
      { error: "Too many requests. Please wait a minute and try again." },
      429,
      origin,
      env
    );
  }
  const auth = await verifyAdminAuth(request, env);
  if (auth.ok) return null;
  if (auth.status === 403) {
    return json(
      { error: "That GitHub account cannot manage this shop's orders." },
      403,
      origin,
      env
    );
  }
  if (auth.status === 503) {
    return json({ error: "Could not reach GitHub to check your sign-in." }, 503, origin, env);
  }
  return json({ error: "Sign in to the CMS with GitHub first." }, 401, origin, env);
}

/**
 * GET /api/unfulfilled-orders
 * Returns a JSON array of all orders currently marked as 'processing'
 * in the D1 orders table, joined with their original emails.
 */
export async function handleUnfulfilledOrders(request, env, origin) {
  const refused = await gate(request, env, origin);
  if (refused) return refused;
  if (!env.STATE_DB) return json({ error: "No database available" }, 503, origin, env);

  const res = await env.STATE_DB.prepare(
    "SELECT session_id, payment_intent, email_hash, created, amount_total, currency, status, line_items_json FROM orders WHERE status = 'processing' ORDER BY created ASC"
  ).all();

  const orders = res && res.results ? res.results : [];

  // Resolve email addresses sequentially since this is an admin/internal endpoint
  for (const order of orders) {
    if (order.email_hash) {
      const email = await emailForHash(env.STATE_DB, order.email_hash);
      order.email = email || "(unknown)";
    }
  }

  return json({ orders }, 200, origin, env);
}

/**
 * POST /api/fulfill-order
 * Takes { payment_intent, tracking_url, status } and pushes it directly
 * to Stripe PaymentIntent metadata. This automatically triggers the ship-notice
 * hourly sweep and updates the order status in D1.
 *
 * Every field is validated before it goes anywhere near the Stripe path or
 * the metadata: the intent id must look like one (it is a URL segment), the
 * status must be one of FULFILLMENT_STATUSES, and a tracking link must be an
 * http(s) URL of at most 500 characters -- a bad one is refused with a 400
 * rather than silently dropped, so the owner notices before the customer does.
 */
export async function handleFulfillOrder(request, env, origin) {
  const refused = await gate(request, env, origin);
  if (refused) return refused;
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: "Stripe not configured" }, 503, origin, env);
  }

  const body = await readJson(request, "Invalid JSON");

  const paymentIntent = typeof body.payment_intent === "string" ? body.payment_intent.trim() : "";
  if (!paymentIntent) throw new ClientError("Missing payment_intent");
  if (!PAYMENT_INTENT_RE.test(paymentIntent)) {
    throw new ClientError("payment_intent is not a Stripe PaymentIntent id.");
  }

  const status = String(body.status || "shipped")
    .toLowerCase()
    .trim();
  if (!FULFILLMENT_STATUSES.includes(status)) {
    throw new ClientError(`status must be one of: ${FULFILLMENT_STATUSES.join(", ")}.`);
  }

  const rawTracking = body.tracking_url == null ? "" : String(body.tracking_url).trim();
  let trackingUrl = "";
  if (rawTracking) {
    if (rawTracking.length > TRACKING_URL_MAX) {
      throw new ClientError(`tracking_url must be at most ${TRACKING_URL_MAX} characters.`);
    }
    trackingUrl = safeUrl(rawTracking) || "";
    if (!trackingUrl) throw new ClientError("tracking_url must be an http(s) link.");
  }

  const shippedAt = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  const params = new URLSearchParams();
  params.append("metadata[fulfillment_status]", status);
  // A shipped save without a link leaves whatever is already on the intent
  // alone (it may have been typed into the Stripe Dashboard).
  if (trackingUrl) params.append("metadata[tracking_url]", trackingUrl);
  params.append("metadata[shipped_at]", shippedAt);

  const updated = await stripePost(
    env,
    `/payment_intents/${encodeURIComponent(paymentIntent)}`,
    params
  );

  if (!updated) {
    // stripePost internally logs the error
    return json({ error: "Failed to update Stripe PaymentIntent" }, 500, origin, env);
  }

  return json({ success: true }, 200, origin, env);
}
