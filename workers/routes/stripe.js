/**
 * @fileoverview The one place this repository names a Stripe API version, plus
 * the small request helpers every route shares.
 *
 * It used to be "ONE VALUE, FOUR FILES": workers/checkout.js and the three
 * Netlify functions each pinned `2026-06-24.dahlia` in their own const, and
 * they read and wrote the SAME Stripe objects. A version bumped in one file and
 * not the others meant one side sent a shape the other could not parse. The
 * Netlify functions are retired and every caller now imports from here, so the
 * value is pinned once and cannot drift.
 *
 * Pinned explicitly rather than left to the account's dashboard default, so a
 * change made in the Stripe Dashboard can never silently alter these requests.
 * Bump it deliberately -- re-check every `session.…` field read in this
 * directory still holds -- rather than letting it age for years.
 */
export const STRIPE_API_VERSION = "2026-06-24.dahlia";

export const STRIPE_API_BASE = "https://api.stripe.com/v1";

function authHeaders(env, extra) {
  return {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Stripe-Version": STRIPE_API_VERSION,
    ...(extra || {})
  };
}

/** GET a Stripe resource. Returns the parsed body, or null on any failure. */
export async function stripeGet(env, pathAndQuery) {
  const res = await fetch(`${STRIPE_API_BASE}${pathAndQuery}`, { headers: authHeaders(env) });
  if (!res || !res.ok) return null;
  return res.json();
}

/**
 * POST form-encoded params to Stripe.
 *
 * @param {object} env             needs STRIPE_SECRET_KEY
 * @param {string} pathname        e.g. "/coupons"
 * @param {URLSearchParams|object} params
 * @param {string} [idempotencyKey] Stripe replays the original response for a
 *   repeated key, which is what makes a redelivered webhook safe to re-run.
 * @returns {Promise<object|null>} parsed body, or null when Stripe refused
 */
export async function stripePost(env, pathname, params, idempotencyKey) {
  const body = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  const headers = authHeaders(env, { "Content-Type": "application/x-www-form-urlencoded" });
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${STRIPE_API_BASE}${pathname}`, {
    method: "POST",
    headers,
    body: body.toString()
  });
  if (!res) return null;
  const parsed = await res.json().catch(() => null);
  if (!res.ok || (parsed && parsed.error)) return null;
  return parsed;
}

/**
 * Delete the ephemeral coupon a gift-card redemption minted.
 *
 * An abandoned checkout otherwise leaves a live `amount_off` coupon in the
 * Stripe account, usable by anyone who learns its id, for a balance the shopper
 * still holds. A coupon that is already gone (404) counts as deleted: this runs
 * from a webhook that must be safe to redeliver.
 *
 * @returns {Promise<boolean>} true when the coupon is definitely gone
 */
export async function deleteCoupon(env, couponId) {
  if (!couponId) return true;
  const res = await fetch(`${STRIPE_API_BASE}/coupons/${encodeURIComponent(couponId)}`, {
    method: "DELETE",
    headers: authHeaders(env)
  });
  return Boolean(res && (res.ok || res.status === 404));
}

/**
 * Expire a Checkout Session that must not be paid.
 *
 * Used when the ledger refuses the hold after the session already exists: the
 * shopper must not be able to walk back to that tab and pay a total that was
 * discounted by money the card no longer has.
 */
export async function expireSession(env, sessionId) {
  if (!sessionId) return false;
  const res = await fetch(
    `${STRIPE_API_BASE}/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
    { method: "POST", headers: authHeaders(env) }
  );
  return Boolean(res && res.ok);
}

/**
 * The Checkout Session behind a PaymentIntent. A charge carries no session
 * metadata, so this is how a refund finds what the gift card actually paid.
 *
 * THROWS when the lookup itself fails, and returns null only when Stripe
 * genuinely has no session for that intent. The difference matters: "no
 * session" is a final answer (an invoice or a dashboard charge, nothing to
 * restore), while a failed request must become a non-2xx so Stripe retries --
 * swallowing it silently loses a real refund.
 */
export async function findSessionByPaymentIntent(env, paymentIntentId) {
  if (!paymentIntentId) return null;
  const res = await fetch(
    `${STRIPE_API_BASE}/checkout/sessions?payment_intent=${encodeURIComponent(paymentIntentId)}&limit=1`,
    { headers: authHeaders(env) }
  );
  if (!res || !res.ok) {
    throw new Error(`Could not look up the checkout session for ${paymentIntentId}`);
  }
  const list = await res.json();
  return list && Array.isArray(list.data) && list.data.length ? list.data[0] : null;
}

/**
 * Mint a Stripe Promotion Code against an existing Coupon.
 *
 * This is the mechanism that makes a discount NOT shareable, and it is a
 * property of the Promotion Code, not of the Coupon behind it: one shared
 * coupon (10% off, or $5 off) can back thousands of codes, each with its own
 * `max_redemptions`, `expires_at` and restrictions
 * (https://docs.stripe.com/api/promotion_codes/object).
 *
 * The `code` string is deliberately NOT supplied -- Stripe generates one, so
 * two concurrent mints can never collide on a string we chose. `expiresAt` is
 * epoch SECONDS, as Stripe expects.
 *
 * @param {object} env needs STRIPE_SECRET_KEY
 * @param {{couponId: string, maxRedemptions?: number, expiresAt?: number,
 *          firstTimeTransaction?: boolean, minimumAmountCents?: number,
 *          metadata?: object}} options
 * @param {string} [idempotencyKey] Stripe replays the original response for a
 *   repeated key, so a retried cron tick or a redelivered webhook re-uses the
 *   SAME code instead of minting a second one.
 * @returns {Promise<{id: string, code: string, expiresAt: number|null}|null>}
 *   null when Stripe refused (including a missing or deleted coupon).
 */
export async function createPromotionCode(env, options, idempotencyKey) {
  const opts = options || {};
  if (!opts.couponId) return null;
  const params = new URLSearchParams();
  params.append("coupon", String(opts.couponId));
  params.append("max_redemptions", String(Math.max(1, Number(opts.maxRedemptions) || 1)));
  if (Number.isFinite(Number(opts.expiresAt)) && Number(opts.expiresAt) > 0) {
    params.append("expires_at", String(Math.round(Number(opts.expiresAt))));
  }
  if (opts.firstTimeTransaction) {
    params.append("restrictions[first_time_transaction]", "true");
  }
  if (Number.isFinite(Number(opts.minimumAmountCents)) && Number(opts.minimumAmountCents) > 0) {
    params.append("restrictions[minimum_amount]", String(Math.round(opts.minimumAmountCents)));
    params.append("restrictions[minimum_amount_currency]", "usd");
  }
  for (const [key, value] of Object.entries(opts.metadata || {})) {
    // Metadata is world-readable in the Stripe Dashboard and shows up in
    // exports: hashes and ids only, never the customer's address.
    params.append(`metadata[${key}]`, String(value).slice(0, 500));
  }
  const created = await stripePost(env, "/promotion_codes", params, idempotencyKey);
  if (!created || typeof created.code !== "string") return null;
  return {
    id: String(created.id),
    code: created.code,
    expiresAt: Number.isFinite(Number(created.expires_at)) ? Number(created.expires_at) : null
  };
}
