/**
 * Netlify Function: Gift Card Live Balance & Status Lookup.
 *
 * Endpoint: POST /.netlify/functions/gift-card-balance  {"code":"YALL-XXXXXXXX"}
 *           (GET ?code=... is still accepted for older clients)
 *
 * Looks up the active Stripe Promotion Code matching the provided code string,
 * retrieves the current stored-value balance, and returns real-time balance
 * information so shoppers can check their remaining card value on-site.
 *
 * This endpoint is a balance ORACLE: anyone who can reach it can ask "is this
 * code real, and what is on it?". It cannot be made unguessable (the codes are
 * 8 characters from a 36-symbol alphabet, deliberately human-typeable), so it
 * is hardened in the ways that are actually available here:
 *
 *   - POST with a JSON body is the preferred call, so codes stop appearing in
 *     URLs -- query strings end up in browser history, Referer headers, CDN
 *     and proxy access logs, and analytics. GET stays supported for clients
 *     that haven't switched yet.
 *   - Cache-Control: no-store on EVERY response, so no shared cache, CDN or
 *     browser keeps a balance answer around to be replayed later.
 *   - One generic "not found" answer covers "no such code", "inactive",
 *     "fully redeemed" and "no monetary balance": a distinct message for each
 *     turns this into an enumeration tool that says which guesses were real.
 *
 * What is NOT here: rate limiting. Netlify Functions are stateless and this
 * project has no shared store (no Redis, no database, no Netlify Blobs) to
 * count attempts in, and per-instance counters are trivially bypassed by
 * spreading requests across cold starts. Documented, with the options for
 * fixing it properly, in workers/README.md.
 */

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
// One value, four files -- see the STRIPE_API_VERSION note in
// workers/checkout.js. Bump all four together or none of them.
const STRIPE_API_VERSION = "2026-06-24.dahlia";

// Deliberately identical for "no such code", "inactive", "already fully
// redeemed" and "coupon carries no amount_off". Anything more specific tells
// a guesser which codes exist.
const GENERIC_NOT_FOUND = "Gift card code not found, inactive, or fully redeemed.";

const ALLOWED_ORIGINS = [
  "https://yallternativeliving.com",
  "https://www.yallternativeliving.com",
  "http://localhost:8080",
  "http://localhost:8082",
  "http://localhost:8083",
  "http://localhost:8085",
  "http://127.0.0.1:8080",
  "http://127.0.0.1:8082",
  "http://127.0.0.1:8083",
  "http://127.0.0.1:8085"
];

function getCorsHeaders(origin) {
  const isAllowed =
    ALLOWED_ORIGINS.includes(origin) ||
    (process.env.SITE_ORIGIN && origin === process.env.SITE_ORIGIN);
  const allow = isAllowed ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    // A gift card balance is per-shopper, per-second data that must never sit
    // in a CDN, a proxy or the browser's back/forward cache.
    "Cache-Control": "no-store",
    Vary: "Origin"
  };
}

async function lookupGiftCardBalance(code, secretKey) {
  if (!code || typeof code !== "string") {
    return { valid: false, error: "Please enter a gift card code." };
  }

  const cleanCode = code.trim().toUpperCase();
  if (!/^YALL-(?:PTS-)?[A-Z0-9]{6,16}$/.test(cleanCode)) {
    return {
      valid: false,
      error: "Invalid code format. Format must be YALL-XXXXXXXX or YALL-PTS-XXXXXXXX."
    };
  }

  const key = secretKey || process.env.STRIPE_SECRET_KEY || STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }

  // Look up active promotion codes matching the code
  const params = new URLSearchParams({
    code: cleanCode,
    active: "true",
    limit: "1",
    "expand[]": "data.coupon"
  });

  const res = await fetch(`https://api.stripe.com/v1/promotion_codes?${params.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      "Stripe-Version": STRIPE_API_VERSION
    }
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(`Stripe API error: ${errBody.error ? errBody.error.message : res.statusText}`);
  }

  const list = await res.json();
  if (!list || !Array.isArray(list.data) || list.data.length === 0) {
    return { valid: false, code: cleanCode, error: GENERIC_NOT_FOUND };
  }

  const promo = list.data[0];
  const coupon = promo.coupon;
  if (!coupon || !coupon.amount_off) {
    // Same answer as "not found": distinguishing "this code exists but is
    // spent" from "this code does not exist" confirms real codes to a
    // guesser, which is exactly what the enumeration is looking for.
    return { valid: false, code: cleanCode, error: GENERIC_NOT_FOUND };
  }

  const balanceCents = coupon.amount_off;
  const balanceDollars = balanceCents / 100;
  const initialCents =
    (promo.metadata && Number(promo.metadata.initial_amount_cents)) ||
    (coupon.metadata && Number(coupon.metadata.initial_amount_cents)) ||
    balanceCents;

  return {
    valid: true,
    code: cleanCode,
    balanceCents: balanceCents,
    balance: balanceDollars,
    formattedBalance: `$${balanceDollars.toFixed(2)}`,
    initialAmountCents: initialCents,
    initialAmount: initialCents / 100,
    currency: coupon.currency || "usd",
    expires: null // Y'allternative Living gift cards never expire
  };
}

exports.handler = async (event) => {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || "";
  const cors = getCorsHeaders(origin);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: cors,
      body: JSON.stringify({ error: "Method Not Allowed" })
    };
  }

  try {
    // POST carries the code in a JSON body (preferred: keeps it out of URLs,
    // history and access logs); GET keeps working for older clients.
    let code;
    if (event.httpMethod === "POST") {
      let parsed = {};
      try {
        parsed = event.body ? JSON.parse(event.body) : {};
      } catch (e) {
        return {
          statusCode: 400,
          headers: cors,
          body: JSON.stringify({ valid: false, error: "Please enter a gift card code." })
        };
      }
      code = parsed && parsed.code;
    } else {
      code = (event.queryStringParameters || {}).code;
    }

    const result = await lookupGiftCardBalance(code);
    return {
      statusCode: result.valid ? 200 : 404,
      headers: cors,
      body: JSON.stringify(result)
    };
  } catch (err) {
    console.error("Gift card balance lookup error:", err);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: "Unable to check gift card balance at this time." })
    };
  }
};

exports.lookupGiftCardBalance = lookupGiftCardBalance;
exports.getCorsHeaders = getCorsHeaders;
exports.GENERIC_NOT_FOUND = GENERIC_NOT_FOUND;
