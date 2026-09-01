/* ==========================================================================
   netlify/functions/redeem-points.js
   Y'allternative Living — Alt-Points Loyalty to Gift Voucher Conversion
   --------------------------------------------------------------------------
   Converts customer Alt-Points into a real stored-value Stripe Promotion Code
   and Coupon (prefixed with YALL-PTS-), allowing balance carryover across
   orders. Dispatches a confirmation email with the voucher code via Resend.
   ========================================================================== */

const crypto = require("crypto");

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_API_VERSION = "2024-06-20";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL =
  process.env.GIFT_CARD_FROM_EMAIL || "orders@yallternativeliving.com";

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

exports.handler = async function (event) {
  const origin = event.headers.origin || event.headers.Origin || "*";
  const corsHeaders = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method Not Allowed. Use POST." })
    };
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const points = Number(body.points);
    const email = body.email ? String(body.email).trim().toLowerCase() : "";

    if (!points || !REDEMPTION_TIERS[points]) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Invalid redemption tier. Valid tiers: 100 ($5), 200 ($10), 500 ($25)."
        })
      };
    }

    const tier = REDEMPTION_TIERS[points];
    const code = deriveRewardCode();

    await createRewardPromotionCode(
      tier.discountCents,
      code,
      email,
      points,
      process.env.STRIPE_SECRET_KEY || STRIPE_SECRET_KEY
    );

    if (email) {
      await sendRewardEmail(email, code, tier.discountDollars, points);
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        code: code,
        pointsRedeemed: points,
        balance: tier.discountDollars,
        balanceCents: tier.discountCents,
        formattedBalance: `$${tier.discountDollars.toFixed(2)}`
      })
    };
  } catch (err) {
    console.error("Points redemption error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Could not redeem Alt-Points. Please try again later."
      })
    };
  }
};

exports.deriveRewardCode = deriveRewardCode;
exports.createRewardPromotionCode = createRewardPromotionCode;
exports.sendRewardEmail = sendRewardEmail;
exports.REDEMPTION_TIERS = REDEMPTION_TIERS;
