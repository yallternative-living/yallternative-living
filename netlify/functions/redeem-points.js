/* ==========================================================================
   netlify/functions/redeem-points.js
   Y'allternative Living — Alt-Points redemption: DISABLED ENDPOINT
   --------------------------------------------------------------------------
   THIS ENDPOINT MINTS NOTHING. Every non-OPTIONS request gets 410 Gone.

   It used to convert "Alt-Points" into a real stored-value Stripe Promotion
   Code (YALL-PTS-), and it did so on the word of the caller alone. There is
   no server-side points ledger anywhere in this project: the balance lives in
   the shopper's own browser (localStorage), the request body simply says
   `{"points": 500}`, and nothing here could check whether those points were
   ever earned or had already been spent. A single POST from a terminal --
   repeated in a loop -- minted unlimited real store credit, redeemable at
   checkout like cash, with no record that would even let it be reconciled
   after the fact.

   Turning the endpoint off is the only correct fix available without a
   ledger: the discount codes it created are indistinguishable from real gift
   cards once they exist, so there is nothing to claw back afterwards. The
   loyalty UI is hidden client-side; this returns 410 (Gone, not 404) so the
   old URL is honest about having been withdrawn, and so any cached client
   still calling it shows the shopper a real message instead of a spinner.

   The pure helpers below (code derivation, the tier table, and the Stripe /
   Resend calls) are kept EXPORTED but UNREACHABLE from the handler: they are
   the shape a future ledger-backed implementation would take, and the test
   suite pins their behaviour. Nothing in exports.handler calls them -- do not
   wire them back up without a server-side ledger that can verify a balance
   and record the spend atomically.
   ========================================================================== */

const crypto = require("crypto");

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
// Kept in lockstep with workers/checkout.js, fulfill-gift-card.js and
// gift-card-balance.js -- see the note on STRIPE_API_VERSION in
// workers/checkout.js. All four move together or none of them do.
const STRIPE_API_VERSION = "2026-06-24.dahlia";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.GIFT_CARD_FROM_EMAIL || "orders@yallternativeliving.com";

// Same allowlist shape as gift-card-balance.js: the request Origin is checked
// against a fixed list and never reflected back, so a hostile page can't turn
// this endpoint into a same-origin-looking call of its own.
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Vary: "Origin"
  };
}

const DISABLED_MESSAGE = "Alt-Points redemption is not available yet.";

const REDEMPTION_TIERS = {
  100: { discountCents: 500, discountDollars: 5.0 },
  200: { discountCents: 1000, discountDollars: 10.0 },
  500: { discountCents: 2500, discountDollars: 25.0 }
};

function deriveRewardCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += chars[crypto.randomInt(0, chars.length)];
  }
  return `YALL-PTS-${suffix}`;
}

async function createRewardPromotionCode(amountCents, code, email, points, secretKey) {
  const key = secretKey || process.env.STRIPE_SECRET_KEY || STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");

  // 1. Create Stripe coupon
  const couponParams = new URLSearchParams({
    amount_off: String(amountCents),
    currency: "usd",
    duration: "forever",
    name: `Alt-Points Loyalty Reward ($${(amountCents / 100).toFixed(2)})`,
    "metadata[source]": "alt_points",
    "metadata[points_redeemed]": String(points),
    "metadata[initial_amount_cents]": String(amountCents),
    "metadata[remaining_balance_cents]": String(amountCents),
    "metadata[recipient_email]": email || ""
  });

  const couponRes = await fetch("https://api.stripe.com/v1/coupons", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_API_VERSION
    },
    body: couponParams
  });

  if (!couponRes.ok) {
    const errText = await couponRes.text();
    throw new Error(`Failed to create reward coupon in Stripe: ${errText}`);
  }

  const coupon = await couponRes.json();

  // 2. Create Stripe Promotion Code with custom code string
  const promoParams = new URLSearchParams({
    coupon: coupon.id,
    code: code,
    "metadata[source]": "alt_points",
    "metadata[points_redeemed]": String(points),
    "metadata[initial_amount_cents]": String(amountCents),
    "metadata[remaining_balance_cents]": String(amountCents),
    "metadata[recipient_email]": email || ""
  });

  const promoRes = await fetch("https://api.stripe.com/v1/promotion_codes", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_API_VERSION
    },
    body: promoParams
  });

  if (!promoRes.ok) {
    const errText = await promoRes.text();
    throw new Error(`Failed to create reward promotion code in Stripe: ${errText}`);
  }

  return await promoRes.json();
}

async function sendRewardEmail(email, code, amountDollars, points, resendKey) {
  const key = resendKey || process.env.RESEND_API_KEY || RESEND_API_KEY;
  if (!key || !email) return { sent: false };

  const subject = `✨ Your $${amountDollars.toFixed(2)} Alt-Points Reward Voucher (${code})`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a1a; padding: 24px; border: 1px solid #e0e0e0; border-radius: 8px;">
      <h2 style="color: #2b1810; margin-top: 0;">✨ Alt-Points Reward Unlocked!</h2>
      <p>Howdy! You just redeemed <strong>${points} Alt-Points</strong> for a <strong>$${amountDollars.toFixed(2)} Store Credit Voucher</strong>.</p>
      <div style="background: #f7f3ed; border: 2px dashed #8b5a2b; border-radius: 8px; padding: 20px; text-align: center; margin: 24px 0;">
        <p style="margin: 0 0 8px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: #666;">Your Reward Code</p>
        <p style="font-size: 28px; font-weight: 800; letter-spacing: 2px; color: #2b1810; margin: 0; font-family: monospace;">${code}</p>
        <p style="margin: 8px 0 0 0; font-size: 14px; color: #666;">Value: <strong>$${amountDollars.toFixed(2)}</strong> (Includes Balance Carryover!)</p>
      </div>
      <p style="font-size: 14px; color: #555;">Apply this code directly in your cart or at checkout on <a href="https://yallternativeliving.com/shop.html" style="color: #8b5a2b;">yallternativeliving.com</a>. If your order is less than $${amountDollars.toFixed(2)}, any remaining balance stays on your code for next time.</p>
      <p style="font-size: 13px; color: #888; margin-top: 24px; border-top: 1px solid #eee; padding-top: 16px;">With gratitude,<br><strong>Y'allternative Living</strong><br>Landrum, South Carolina</p>
    </div>
  `;

  const text = `Alt-Points Reward Unlocked!\n\nYou redeemed ${points} Alt-Points for a $${amountDollars.toFixed(2)} Store Credit Voucher.\n\nCode: ${code}\nValue: $${amountDollars.toFixed(2)}\n\nRedeem at https://yallternativeliving.com/shop.html\nUnused balances automatically carry over.`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: email,
        subject: subject,
        html: html,
        text: text
      })
    });
    return { sent: res.ok };
  } catch (e) {
    console.warn("Could not dispatch reward email:", e.message);
    return { sent: false };
  }
}

/**
 * Disabled endpoint. Every non-OPTIONS request -- GET, POST, anything --
 * returns 410 Gone with the same body, so there is no shape of request that
 * reaches Stripe or Resend from here. See the file header for why.
 *
 * Deliberately NOT method-dependent: a 405 on GET would imply POST still
 * works, and a 400 on a bad tier would imply a good tier mints something.
 * One answer, always.
 */
exports.handler = async function (event) {
  const origin = (event && event.headers && (event.headers.origin || event.headers.Origin)) || "";
  const headers = getCorsHeaders(origin);

  if (event && event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  return {
    statusCode: 410,
    headers,
    body: JSON.stringify({ error: DISABLED_MESSAGE })
  };
};

exports.DISABLED_MESSAGE = DISABLED_MESSAGE;
exports.getCorsHeaders = getCorsHeaders;
exports.ALLOWED_ORIGINS = ALLOWED_ORIGINS;

exports.deriveRewardCode = deriveRewardCode;
exports.createRewardPromotionCode = createRewardPromotionCode;
exports.sendRewardEmail = sendRewardEmail;
exports.REDEMPTION_TIERS = REDEMPTION_TIERS;
