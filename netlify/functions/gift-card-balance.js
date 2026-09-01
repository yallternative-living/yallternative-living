/**
 * Netlify Function: Gift Card Live Balance & Status Lookup.
 *
 * Endpoint: GET /.netlify/functions/gift-card-balance?code=YALL-XXXX-XXXX
 *           or /api/gift-card-balance?code=YALL-XXXX-XXXX
 *
 * Looks up the active Stripe Promotion Code matching the provided code string,
 * retrieves the current stored-value balance, and returns real-time balance
 * information so shoppers can check their remaining card value on-site.
 */

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_API_VERSION = "2026-06-24.dahlia";

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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
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
    return {
      valid: false,
      code: cleanCode,
      error: "Gift card code not found, inactive, or fully redeemed."
    };
  }

  const promo = list.data[0];
  const coupon = promo.coupon;
  if (!coupon || !coupon.amount_off) {
    return {
      valid: false,
      code: cleanCode,
      error: "Gift card has no monetary balance remaining."
    };
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

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: cors,
      body: JSON.stringify({ error: "Method Not Allowed" })
    };
  }

  try {
    const params = event.queryStringParameters || {};
    const code = params.code;

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
