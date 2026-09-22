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
 * belongs to and whether it may push to the shop's repository.
 *
 * There is NO shared password. There used to be (`ADMIN_PASSWORD`), and a
 * shared secret on a public endpoint is guessable no matter how carefully it
 * is compared -- so it is gone rather than kept as a fallback, because a
 * fallback would have been the weakest link and the only one worth attacking.
 *
 * WHAT GITHUB IS ASKED, AND WHY EACH QUESTION
 *
 * 1. What can this TOKEN do? `permissions.push` on a repository describes the
 *    ACCOUNT's role, not the token: a "Sign in with GitHub" token some other
 *    site holds for the owner, minted with no scopes at all, reports the same
 *    push:true. So for a classic token -- `gho_` from an OAuth app, `ghp_`
 *    typed by hand -- its own scopes must include `public_repo` (what the CMS
 *    asks for) or `repo`. A fine-grained token (`github_pat_`, which is how
 *    the owner signs in to the CMS) reports no scopes at all, so it is asked
 *    directly whether it may write this repository -- see
 *    probeContentsWrite(). Any other token shape is refused. A token that
 *    passes can already push to the shop's repository, so this dashboard
 *    grants it nothing it could not take anyway.
 * 2. Which APP issued it? Optional: with GITHUB_CLIENT_ID and
 *    GITHUB_CLIENT_SECRET set (the CMS OAuth app's own, the pair
 *    cms-auth/sveltia-auth.js holds) the token is checked through
 *    `POST /applications/{client_id}/token`, which only answers for tokens
 *    that app issued. Every other token -- another app's, or a personal
 *    access token pasted into the CMS -- is then refused, so leave the pair
 *    unset while anyone signs in to the CMS with a token. Set the id without
 *    the secret and every request is refused (503): half a configuration
 *    fails closed.
 * 3. May the account push? `GET /repos/{owner}/{repo}` and `permissions.push`.
 *    The repository is PUBLIC, so any signed-in stranger's token also gets a
 *    200 from that call -- with push:false. The push bit, not the status code,
 *    separates the shop's owner from the rest of GitHub.
 *
 * COST CONTROL, NOT A LOCK. A token that does not look like a GitHub token is
 * refused before anything else runs, and a verdict GitHub already gave is
 * served from a short per-isolate cache; neither touches the limiter. Only a
 * request that would actually go to GitHub is counted, in ONE GLOBAL bucket
 * that fails OPEN. Counting everything let anyone lock the owner out with 30
 * header-less requests a minute. What is left: a caller who keeps sending 30
 * well-formed fake tokens a minute (each costing a real GitHub round trip)
 * can still hold the bucket, and an owner whose token is not cached in that
 * isolate waits it out -- the Stripe Dashboard stays available meanwhile.
 */

import { json, ClientError, readJson } from "./http.js";
import { checkRateLimit } from "../state/rate-limit.js";
import { stripePost } from "./stripe.js";
import { emailForHash } from "../state/orders.js";
import { SHIPPED_STATUSES } from "./ship-notice.js";
import { safeUrl } from "../state/stripe-orders.js";

/**
 * GitHub verifications per minute across BOTH admin routes together, all
 * callers in one bucket. Only a request that reaches GitHub is counted (see
 * gate()), so the owner's cached session never spends it. The key is a
 * constant on purpose: on the workers.dev hostname a caller picks its own
 * X-Forwarded-For, so a per-IP bucket would be per-attacker-string
 * (routes/http.js clientIp()).
 */
export const ADMIN_AUTH_RATE_LIMIT = { limit: 30, period: 60 };
const ADMIN_AUTH_RATE_KEY = "admin-auth";

/** The repository whose push access grants the dashboard. Overridable per env. */
const DEFAULT_GITHUB_REPO = "yallternative-living/yallternative-living";

/**
 * Token shapes accepted (docs: "about authentication to GitHub"): `gho_` is
 * what the CMS OAuth flow mints, `ghp_` a classic personal access token, and
 * `github_pat_` a fine-grained one -- what the CMS's token sign-in is given.
 * GitHub App tokens (`ghu_`, `ghs_`) are refused: they report no scopes and
 * nobody signs in to the CMS with one. Anything else never reaches
 * api.github.com.
 */
const GITHUB_TOKEN_RE = /^(?:gho|ghp|github_pat)_[A-Za-z0-9_]{20,255}$/;
const FINE_GRAINED_PREFIX = "github_pat_";

/**
 * The write probeContentsWrite() attempts: a branch pointing at the all-zero
 * object id, which no object can have, so GitHub can never create it.
 */
const PROBE_REF = "refs/heads/fulfillment-dashboard-access-check";
const ZERO_SHA = "0".repeat(40);

/** Classic scopes that include pushing to a public repository. */
const PUSH_SCOPES = ["repo", "public_repo"];

/**
 * How long a verdict is trusted without asking GitHub again. A yes is kept
 * one minute, so a revoked token or a removed collaborator stops working
 * quickly; a no is kept five, so a flood of the same bad token stays free.
 */
const TOKEN_OK_CACHE_MS = 60 * 1000;
const TOKEN_REFUSED_CACHE_MS = 5 * 60 * 1000;

/** Entries past this are dropped oldest-first, so a flood cannot grow the map. */
const TOKEN_CACHE_MAX = 256;

/**
 * token digest -> { ok, status, login, expires }. Per-isolate and therefore
 * best-effort: a cold isolate just asks GitHub again. It exists so one
 * dashboard session (a list plus a dozen "Mark Shipped" clicks) costs a
 * couple of API calls, and so a flood of the same bad token costs none.
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

const GITHUB_API = "https://api.github.com";

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

function githubHeaders(authorization) {
  return {
    Authorization: authorization,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // api.github.com rejects a request with no User-Agent outright.
    "User-Agent": "yallternative-fulfillment"
  };
}

/** `X-OAuth-Scopes: public_repo, read:user` -> ["public_repo", "read:user"]. */
function parseScopes(header) {
  return String(header || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Who the token belongs to and what it may do, without trusting which app
 * issued it: `GET /user` answers with the login, and its `X-OAuth-Scopes`
 * header lists the token's scopes.
 *
 * @returns {Promise<{status: number, login: string, scopes: string[]}>}
 *   status 200 when GitHub accepted the token, 401 when it did not, 503 when
 *   GitHub could not be asked.
 */
async function identifyToken(token) {
  const res = await fetch(`${GITHUB_API}/user`, { headers: githubHeaders(`Bearer ${token}`) });
  if (res.status === 401) return { status: 401, login: "", scopes: [] };
  if (!res.ok) {
    // 403 here is OUR problem (rate limit, bad User-Agent), not the caller's.
    console.error(`fulfillment: GitHub refused the identity check (${res.status})`);
    return { status: 503, login: "", scopes: [] };
  }
  const body = await res.json().catch(() => null);
  return {
    status: 200,
    login: (body && typeof body.login === "string" && body.login) || "",
    scopes: parseScopes(res.headers.get("X-OAuth-Scopes"))
  };
}

/**
 * The same answer, but only for a token the CMS's own OAuth app issued:
 * `POST /applications/{client_id}/token`, authenticated as the app. GitHub
 * answers 404 for a token any other app issued (or one that is not valid).
 */
async function identifyAppToken(token, clientId, clientSecret) {
  const res = await fetch(`${GITHUB_API}/applications/${encodeURIComponent(clientId)}/token`, {
    method: "POST",
    headers: {
      ...githubHeaders(`Basic ${btoa(`${clientId}:${clientSecret}`)}`),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ access_token: token })
  });
  if (res.status === 404 || res.status === 422) return { status: 401, login: "", scopes: [] };
  if (!res.ok) {
    // 401 here means OUR client id / secret are wrong -- a configuration
    // problem, never a verdict on the caller's token.
    console.error(`fulfillment: GitHub refused the OAuth app token check (${res.status})`);
    return { status: 503, login: "", scopes: [] };
  }
  const body = await res.json().catch(() => null);
  const user = body && body.user;
  return {
    status: 200,
    login: (user && typeof user.login === "string" && user.login) || "",
    scopes: body && Array.isArray(body.scopes) ? body.scopes.map(String) : []
  };
}

/**
 * Ask GitHub whether this token may push to the shop's repository: checks 1-3
 * in the file header, in that order, stopping at the first no.
 *
 * @returns {Promise<{ok: boolean, status: number, login: string}>}
 *   `ok` true only when every check passed. `status` is what the caller
 *   should answer: 401 for a token GitHub (or the CMS app) will not accept,
 *   403 for a real token without the scope or the push access, 503 when
 *   GitHub could not be reached or this Worker is misconfigured.
 */
async function verifyGitHubPush(token, env) {
  const clientId = env && typeof env.GITHUB_CLIENT_ID === "string" && env.GITHUB_CLIENT_ID.trim();
  let identity;
  if (clientId) {
    const clientSecret = env.GITHUB_CLIENT_SECRET;
    if (typeof clientSecret !== "string" || !clientSecret) {
      console.error("fulfillment: GITHUB_CLIENT_ID is set without GITHUB_CLIENT_SECRET");
      return { ok: false, status: 503, login: "" };
    }
    identity = await identifyAppToken(token, clientId, clientSecret);
  } else {
    identity = await identifyToken(token);
  }
  if (identity.status !== 200) return { ok: false, status: identity.status, login: "" };
  const login = identity.login;
  // A fine-grained token has no scopes to read; probeContentsWrite() below
  // stands in for this check once the account is known to have push.
  const fineGrained = token.startsWith(FINE_GRAINED_PREFIX);
  if (!fineGrained && !identity.scopes.some((s) => PUSH_SCOPES.includes(s))) {
    return { ok: false, status: 403, login };
  }

  const res = await fetch(`${GITHUB_API}/repos/${repoOf(env)}`, {
    headers: githubHeaders(`Bearer ${token}`)
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
  // Defensive: absent `permissions` is treated as no permission, never as yes.
  if (!perms || perms.push !== true) return { ok: false, status: 403, login };
  if (fineGrained) {
    const status = await probeContentsWrite(token, env);
    if (status !== 200) return { ok: false, status, login: status === 403 ? login : "" };
  }
  return { ok: true, status: 200, login };
}

/**
 * May this fine-grained token write the repository's contents? GitHub has no
 * endpoint that says, and `permissions` on the repository describes the
 * account, so it is asked with a write that cannot succeed: create
 * PROBE_REF pointing at ZERO_SHA. GitHub checks a fine-grained token's
 * permission for the endpoint before it reads the request, so a token without
 * Contents write is refused (403, "Resource not accessible by personal access
 * token") while one with it gets as far as validating the SHA (422, "Object
 * does not exist"). Nothing is created either way. Only the 422 counts as
 * yes: every other answer is a no (403/404) or a failure to ask (503).
 *
 * @returns {Promise<number>} 200 when the token may write, 401 when GitHub
 *   refuses the token, 403 when it may not write, 503 when GitHub could not
 *   answer (a rate limit included -- that is about us, not the token).
 */
async function probeContentsWrite(token, env) {
  const res = await fetch(`${GITHUB_API}/repos/${repoOf(env)}/git/refs`, {
    method: "POST",
    headers: { ...githubHeaders(`Bearer ${token}`), "Content-Type": "application/json" },
    body: JSON.stringify({ ref: PROBE_REF, sha: ZERO_SHA })
  });
  if (res.status === 422) return 200;
  if (res.status === 401) return 401;
  const rateLimited = res.headers.get("X-RateLimit-Remaining") === "0";
  if ((res.status === 403 || res.status === 404) && !rateLimited) return 403;
  console.error(`fulfillment: GitHub did not answer the write check (${res.status})`);
  return 503;
}

function cacheVerdict(key, result, now) {
  const ttl = result.ok ? TOKEN_OK_CACHE_MS : TOKEN_REFUSED_CACHE_MS;
  tokenCache.set(key, {
    ok: result.ok,
    status: result.status,
    login: result.login,
    expires: now + ttl
  });
  if (tokenCache.size > TOKEN_CACHE_MAX) {
    for (const [k, v] of tokenCache) if (v.expires <= now) tokenCache.delete(k);
    // Still over after the expired ones went: drop the oldest (Map keeps
    // insertion order), so a flood of distinct tokens cannot grow it.
    while (tokenCache.size > TOKEN_CACHE_MAX) tokenCache.delete(tokenCache.keys().next().value);
  }
}

/**
 * The bearer token: shape check and cache first -- both free, neither
 * counted -- then the global bucket, then GitHub, then cached.
 * @returns {Promise<{ok: boolean, status: number, login: string}>} status 429
 *   when the bucket is full; otherwise as verifyGitHubPush().
 */
async function verifyAdminAuth(request, env, now = Date.now()) {
  const token = bearerToken(request);
  if (!token || !GITHUB_TOKEN_RE.test(token)) return { ok: false, status: 401, login: "" };

  const key = await sha256Hex(token);
  const hit = tokenCache.get(key);
  if (hit && hit.expires > now) return { ok: hit.ok, status: hit.status, login: hit.login };

  const limit = await checkRateLimit(env, ADMIN_AUTH_RATE_KEY, {
    ...ADMIN_AUTH_RATE_LIMIT,
    // Fails OPEN: the credential is a GitHub token, not a guessable secret,
    // so this bucket is cost control and must not lock the owner out.
    failOpen: true
  });
  if (!limit.success) return { ok: false, status: 429, login: "" };

  const result = await verifyGitHubPush(token, env);
  // A 503 is about GitHub or this Worker, not about this token: never cached.
  if (result.status !== 503) cacheVerdict(key, result, now);
  return result;
}

/** What each refusal says; anything else from verifyAdminAuth() is a 401. */
const REFUSALS = {
  401: "Sign in to the CMS with GitHub first.",
  403: "That GitHub account cannot manage this shop's orders.",
  429: "Too many requests. Please wait a minute and try again.",
  503: "Could not reach GitHub to check your sign-in."
};

/**
 * Returns `{refused}` with the Response to send when the caller is refused,
 * or `{refused: null, login}` -- the GitHub login, for the audit log line --
 * when they may proceed.
 */
async function gate(request, env, origin) {
  const auth = await verifyAdminAuth(request, env);
  if (auth.ok) return { refused: null, login: auth.login };
  const status = REFUSALS[auth.status] ? auth.status : 401;
  return { refused: json({ error: REFUSALS[status] }, status, origin, env), login: "" };
}

/**
 * GET /api/unfulfilled-orders
 * Returns a JSON array of all orders currently marked as 'processing'
 * in the D1 orders table, joined with their original emails.
 */
export async function handleUnfulfilledOrders(request, env, origin) {
  const { refused, login } = await gate(request, env, origin);
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

  // Customer emails just left the building: say to whom, in the Worker log.
  console.log(
    `fulfillment: ${login || "(unknown login)"} listed ${orders.length} unfulfilled order(s)`
  );
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
  const { refused, login } = await gate(request, env, origin);
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

  // The audit trail: which GitHub account marked which order, and how.
  console.log(`fulfillment: ${login || "(unknown login)"} set ${paymentIntent} to ${status}`);

  return json({ success: true }, 200, origin, env);
}
