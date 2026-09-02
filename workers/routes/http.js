/**
 * @fileoverview Shared HTTP plumbing for every route the checkout Worker owns.
 *
 * One Worker now answers the whole money path (`/api/checkout`,
 * `/api/gift-card-balance`, `/api/stripe-webhook`, `/api/order-status`,
 * `/api/restock`), so the CORS allowlist, the JSON envelope and the
 * "which error is the shopper allowed to read" rule live here rather than being
 * re-implemented per route the way the retired Netlify functions did -- three
 * copies of an allowlist is three chances for one of them to drift open.
 *
 * EVERY JSON RESPONSE IS `Cache-Control: no-store`.
 * Audit C-3: the service worker cached a gift-card balance under a code-less
 * key and then served shopper A's card to shopper B. `no-store` on the response
 * is the half of that fix this side of the wire owns; the other half is sw.js
 * refusing to touch `/api/` at all.
 */

/**
 * Origins allowed to call this Worker from a browser. `env.SITE_ORIGIN` is
 * honoured as well so a preview origin can be added without a code change --
 * it is a [vars] entry in wrangler.toml, not client input.
 */
export const ALLOWED_ORIGINS = [
  "https://yallternativeliving.com",
  "https://www.yallternativeliving.com"
];

/**
 * Errors whose message is safe to show the shopper: cart and validation
 * problems they can act on. Anything that is NOT a ClientError is treated as
 * internal -- logged server-side, replaced by a generic message on the way out
 * -- so raw Stripe strings and unexpected failures never reach a browser.
 *
 * `status` exists because not every shopper-visible refusal is a 400: a gift
 * card whose balance moved between "apply" and "pay" is a 409, and the cart
 * distinguishes the two.
 */
export class ClientError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ClientError";
    this.status = status;
  }
}

export function isAllowedOrigin(origin, env) {
  return Boolean(
    ALLOWED_ORIGINS.includes(origin) || (env && env.SITE_ORIGIN && origin === env.SITE_ORIGIN)
  );
}

export function corsHeaders(origin, env) {
  const allow = isAllowedOrigin(origin, env) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    // Without this a shared cache can hand the www response to an apex caller
    // (and vice versa) with the wrong Allow-Origin baked in.
    Vary: "Origin"
  };
}

export function json(body, status, origin, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(origin, env)
    }
  });
}

/** 204 preflight. Same allowlist, same Vary, no body. */
export function preflight(origin, env) {
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store", ...corsHeaders(origin, env) }
  });
}

/** Parse a JSON body, turning a malformed one into a shopper-safe 400. */
export async function readJson(request, message = "Invalid request payload.") {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch (e) {
    throw new ClientError(message);
  }
}

/**
 * Best-effort client IP, for rate-limit keys only.
 *
 * The site reaches this Worker through a Netlify proxy (`netlify.toml`'s
 * `/api/*` rule), so `CF-Connecting-IP` is NETLIFY's edge address, not the
 * shopper's -- keying on it alone would put every visitor in one bucket and
 * make the limiter useless. Netlify records the real client in
 * `X-Forwarded-For`, so the first entry is preferred and CF-Connecting-IP is
 * the fallback for direct (Cloudflare route) traffic.
 *
 * The first XFF entry is client-influenced and therefore spoofable. That is
 * acceptable HERE and nowhere else: this value only ever picks a counter
 * bucket. Nothing is authorised by it, and the endpoints behind it are safe
 * (if slower) when a determined caller rotates buckets -- see
 * workers/state/rate-limit.js on why a limiter is not the security boundary.
 */
export function clientIp(request) {
  const forwarded = request.headers.get("X-Forwarded-For") || "";
  const first = forwarded.split(",")[0].trim();
  if (first && first.length <= 45) return first;
  const direct = request.headers.get("CF-Connecting-IP");
  return direct ? String(direct).slice(0, 45) : "unknown";
}

/** Escape user-supplied text before it is interpolated into email HTML. */
export function escapeHtml(str) {
  return String(str === null || str === undefined ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Strip the control characters that have no business in an email header, a
 * subject line or Stripe metadata. CR and LF included: this is what stands
 * between a client-supplied string and header injection on the way out.
 */
export function stripControlChars(s) {
  return (
    String(s === null || s === undefined ? "" : s)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .trim()
  );
}
