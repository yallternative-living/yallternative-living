/**
 * Netlify Function: Gift card fulfillment & stored-value balance ledger webhook.
 *
 * Listens for Stripe's `checkout.session.completed` event:
 *   1. Initial Purchase: When a gift card is bought, generates a unique
 *      `YALL-XXXX-XXXX` code, creates a Stripe Coupon/Promotion Code with
 *      the full initial amount, and emails the digital gift card to the
 *      recipient and buyer.
 *   2. Partial Redemption & Balance Carryover: When any order uses a `YALL-`
 *      gift card code, calculates the exact amount spent vs. available balance.
 *      If a residual balance remains (e.g. $26 left of $50), deactivates the
 *      spent promotion code, creates a new coupon/promotion code with the
 *      EXACT SAME code `YALL-XXXX-XXXX` for the remaining balance ($26.00),
 *      and sends an automated "Remaining Balance" email receipt.
 *   3. Zero Exhaustion: If the balance reaches $0.00, marks the card fully
 *      redeemed and sends a completion confirmation.
 */

const { Resend } = require("resend");
const crypto = require("crypto");

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_API_VERSION = "2026-06-24.dahlia";

function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY || "re_test";
  return new Resend(apiKey);
}

// Stripe tolerates clock drift but rejects anything older than this to
// block replay of a captured webhook payload.
const WEBHOOK_TOLERANCE_SECONDS = 300;

function generateRandomCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "YALL-";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(crypto.randomInt(chars.length));
  }
  return result;
}

// Deterministic per (session, gift index): a retried webhook delivery
// (Stripe retries on non-2xx or timeout) must send the promotion-code
// request with EXACTLY the same parameters under the same Idempotency-Key
// to get the original code back.
function deriveGiftCardCode(sessionId, giftIndex, secret) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const digest = crypto
    .createHmac("sha256", String(secret || ""))
    .update("gift-code-" + sessionId + "-" + giftIndex)
    .digest();
  let result = "YALL-";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(digest[i] % chars.length);
  }
  return result;
}

// Escape user-supplied text before interpolating it into email HTML.
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Verify Stripe-Signature header manually.
function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) throw new Error("Missing Stripe-Signature header");
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");

  var timestamp;
  var v1Signatures = [];
  signatureHeader.split(",").forEach(function (pair) {
    var idx = pair.indexOf("=");
    if (idx === -1) return;
    var key = pair.slice(0, idx).trim();
    var val = pair.slice(idx + 1).trim();
    if (key === "t") timestamp = val;
    if (key === "v1") v1Signatures.push(val);
  });
  if (!timestamp || !v1Signatures.length) throw new Error("Malformed Stripe-Signature header");

  var age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > WEBHOOK_TOLERANCE_SECONDS) {
    throw new Error("Webhook timestamp outside tolerance -- possible replay");
  }

  var expected = crypto
    .createHmac("sha256", secret)
    .update(timestamp + "." + rawBody, "utf8")
    .digest("hex");

  var expectedBuf = Buffer.from(expected, "utf8");
  var signatureOk = v1Signatures.some(function (sig) {
    var actualBuf = Buffer.from(sig, "utf8");
    return (
      expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf)
    );
  });
  if (!signatureOk) throw new Error("Signature mismatch");

  return JSON.parse(rawBody);
}

// Create a Stripe Coupon + Promotion Code with stored-value metadata.
async function createGiftCardPromotionCode(
  sessionId,
  giftIndex,
  amountCents,
  code,
  extraMetadata = {}
) {
  var secretKey = process.env.STRIPE_SECRET_KEY || STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not configured");

  var couponIdempotencyKey = "gift-coupon-" + sessionId + "-" + giftIndex;
  var couponBody = new URLSearchParams({
    amount_off: String(amountCents),
    currency: "usd",
    duration: "once",
    max_redemptions: "1",
    name: "Y'allternative Living gift card"
  });

  const metadata = {
    initial_amount_cents: String(extraMetadata.initial_amount_cents || amountCents),
    remaining_balance_cents: String(amountCents),
    recipient_email: String(extraMetadata.recipient_email || ""),
    original_code: code,
    ...extraMetadata
  };

  Object.keys(metadata).forEach((k) => {
    couponBody.append(`metadata[${k}]`, metadata[k]);
  });

  var couponRes = await fetch("https://api.stripe.com/v1/coupons", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + secretKey,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": couponIdempotencyKey,
      "Stripe-Version": STRIPE_API_VERSION
    },
    body: couponBody
  });
  var coupon = await couponRes.json();
  if (coupon.error) throw new Error("Stripe coupon creation failed: " + coupon.error.message);

  var promoIdempotencyKey = "gift-promo-" + sessionId + "-" + giftIndex;
  var promoBody = new URLSearchParams({
    coupon: coupon.id,
    code: code,
    max_redemptions: "1"
  });
  Object.keys(metadata).forEach((k) => {
    promoBody.append(`metadata[${k}]`, metadata[k]);
  });

  var promoRes = await fetch("https://api.stripe.com/v1/promotion_codes", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + secretKey,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": promoIdempotencyKey,
      "Stripe-Version": STRIPE_API_VERSION
    },
    body: promoBody
  });
  var promo = await promoRes.json();
  if (promo.error) throw new Error("Stripe promotion code creation failed: " + promo.error.message);

  return promo.code;
}

// Rollover an existing gift card code to a new remaining balance.
// Deactivates the previous spent promotion code, creates a new coupon for the
// remaining cents, and re-attaches the EXACT SAME code `YALL-XXXX-XXXX`.
async function rolloverGiftCardBalance(
  code,
  oldPromoId,
  newBalanceCents,
  initialAmountCents,
  recipientEmail,
  sessionId
) {
  var secretKey = process.env.STRIPE_SECRET_KEY || STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not configured");

  // 1. Deactivate old promotion code if provided
  if (oldPromoId) {
    try {
      await fetch(`https://api.stripe.com/v1/promotion_codes/${oldPromoId}`, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + secretKey,
          "Content-Type": "application/x-www-form-urlencoded",
          "Stripe-Version": STRIPE_API_VERSION
        },
        body: new URLSearchParams({ active: "false" })
      });
    } catch (e) {
      console.warn("Could not deactivate spent promo code:", e.message);
    }
  }

  if (newBalanceCents <= 0) {
    return { code, balanceCents: 0, status: "exhausted" };
  }

  // 2. Create new coupon for residual balance
  const couponIdemp = `gift-rollover-coupon-${sessionId}-${code}-${newBalanceCents}`;
  const couponRes = await fetch("https://api.stripe.com/v1/coupons", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + secretKey,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": couponIdemp,
      "Stripe-Version": STRIPE_API_VERSION
    },
    body: new URLSearchParams({
      amount_off: String(newBalanceCents),
      currency: "usd",
      duration: "once",
      max_redemptions: "1",
      name: "Y'allternative Living gift card (Balance Rollover)",
      "metadata[initial_amount_cents]": String(initialAmountCents || newBalanceCents),
      "metadata[remaining_balance_cents]": String(newBalanceCents),
      "metadata[recipient_email]": String(recipientEmail || ""),
      "metadata[original_code]": code
    })
  });
  const coupon = await couponRes.json();
  if (coupon.error)
    throw new Error("Stripe rollover coupon creation failed: " + coupon.error.message);

  // 3. Create new promotion code with the EXACT SAME code
  const promoIdemp = `gift-rollover-promo-${sessionId}-${code}-${newBalanceCents}`;
  const promoRes = await fetch("https://api.stripe.com/v1/promotion_codes", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + secretKey,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": promoIdemp,
      "Stripe-Version": STRIPE_API_VERSION
    },
    body: new URLSearchParams({
      coupon: coupon.id,
      code: code,
      max_redemptions: "1",
      "metadata[initial_amount_cents]": String(initialAmountCents || newBalanceCents),
      "metadata[remaining_balance_cents]": String(newBalanceCents),
      "metadata[recipient_email]": String(recipientEmail || "")
    })
  });
  const promo = await promoRes.json();
  if (promo.error) throw new Error("Stripe rollover promo creation failed: " + promo.error.message);

  return { code: promo.code, balanceCents: newBalanceCents, status: "active" };
}

// Find promotion code used in a checkout session
async function findUsedPromotionCode(session, secretKey) {
  const key = secretKey || process.env.STRIPE_SECRET_KEY || STRIPE_SECRET_KEY;
  if (!session || !key) return null;

  // 1. Direct discount on session
  if (session.discounts && Array.isArray(session.discounts) && session.discounts.length > 0) {
    const d = session.discounts[0];
    if (d.promotion_code) {
      if (typeof d.promotion_code === "object" && d.promotion_code.code) {
        return d.promotion_code;
      }
      // Fetch promotion code by ID
      const res = await fetch(`https://api.stripe.com/v1/promotion_codes/${d.promotion_code}`, {
        headers: { Authorization: "Bearer " + key, "Stripe-Version": STRIPE_API_VERSION }
      });
      if (res.ok) return await res.json();
    }
  }

  // 2. Query line item discounts or session discount object
  if (session.discount && session.discount.promotion_code) {
    const promoId =
      typeof session.discount.promotion_code === "object"
        ? session.discount.promotion_code.id
        : session.discount.promotion_code;
    const res = await fetch(`https://api.stripe.com/v1/promotion_codes/${promoId}`, {
      headers: { Authorization: "Bearer " + key, "Stripe-Version": STRIPE_API_VERSION }
    });
    if (res.ok) return await res.json();
  }

  return null;
}

// Handles gift card redemptions on an order
async function handleGiftCardRedemption(session, secretKey) {
  const key = secretKey || process.env.STRIPE_SECRET_KEY || STRIPE_SECRET_KEY;
  const amountDiscountCents = (session.total_details && session.total_details.amount_discount) || 0;
  if (amountDiscountCents <= 0) return null;

  const promo = await findUsedPromotionCode(session, key);
  if (!promo || !promo.code || !promo.code.startsWith("YALL-")) {
    return null; // Not a Y'allternative gift card promotion code
  }

  const coupon = promo.coupon || {};
  const currentBalanceCents =
    coupon.amount_off ||
    Number(promo.metadata && promo.metadata.remaining_balance_cents) ||
    amountDiscountCents;

  const initialAmountCents =
    Number(promo.metadata && promo.metadata.initial_amount_cents) ||
    Number(coupon.metadata && coupon.metadata.initial_amount_cents) ||
    currentBalanceCents;

  const customerEmail =
    (session.customer_details && session.customer_details.email) || session.customer_email;
  const recipientEmail =
    (promo.metadata && promo.metadata.recipient_email) ||
    (coupon.metadata && coupon.metadata.recipient_email) ||
    customerEmail;

  const newBalanceCents = Math.max(0, currentBalanceCents - amountDiscountCents);

  // Rollover remaining balance to fresh active code
  await rolloverGiftCardBalance(
    promo.code,
    promo.id,
    newBalanceCents,
    initialAmountCents,
    recipientEmail,
    session.id
  );

  // Send Remaining Balance Notification via Resend
  const targetEmail = recipientEmail || customerEmail;
  if (targetEmail) {
    const resendClient = getResendClient();
    const fromAddress =
      process.env.FROM_EMAIL ||
      process.env.RESEND_FROM_EMAIL ||
      "Y'allternative Living <gifts@yallternativeliving.com>";

    const spentDollars = (amountDiscountCents / 100).toFixed(2);
    const newBalDollars = (newBalanceCents / 100).toFixed(2);

    let subject, html, text;
    if (newBalanceCents > 0) {
      subject = `Gift Card Balance Update: $${newBalDollars} remaining on ${promo.code}`;
      html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #17130f; color: #fff; padding: 40px; border-radius: 12px; border: 2px solid #d69b5c;">
          <div style="text-align: center; margin-bottom: 30px;">
            <img src="https://yallternativeliving.com/assets/img/logo.png" alt="Y'allternative Living Logo" style="max-width: 200px;" />
          </div>
          <h1 style="color: #d69b5c; text-align: center;">Gift Card Balance Update</h1>
          <p style="font-size: 16px;">You used <strong>$${spentDollars}</strong> from your gift card on your recent order.</p>

          <div style="text-align: center; background: #fff; color: #000; padding: 24px; border-radius: 8px; margin: 25px 0;">
            <p style="margin: 0; text-transform: uppercase; letter-spacing: 2px; font-size: 12px; color: #666;">Remaining Available Balance</p>
            <h2 style="margin: 8px 0; font-size: 36px; color: #17130f; letter-spacing: 1px;">$${newBalDollars}</h2>
            <p style="margin: 4px 0 0 0; font-size: 14px; font-weight: bold; letter-spacing: 2px; color: #333;">Code: ${promo.code}</p>
          </div>

          <p style="font-size: 14px; color: #cfc0a8; line-height: 1.5;">Your gift code <strong>${promo.code}</strong> remains active and will carry over to future orders until your balance reaches $0.00.</p>

          <div style="text-align: center; margin-top: 30px;">
            <a href="https://yallternativeliving.com/shop.html" style="display: inline-block; background: #d69b5c; color: #17130f; text-decoration: none; padding: 14px 28px; font-weight: bold; border-radius: 4px; text-transform: uppercase; letter-spacing: 1px;">Shop The Collection</a>
          </div>
        </div>
      `;
      text =
        `Y'allternative Living Gift Card Balance Update\n\n` +
        `You spent $${spentDollars} on your recent order.\n` +
        `Remaining Balance: $${newBalDollars}\n` +
        `Gift Code: ${promo.code}\n\n` +
        `Your code remains active and can be redeemed on your next order at https://yallternativeliving.com`;
    } else {
      subject = `Gift Card Fully Redeemed: ${promo.code}`;
      html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #17130f; color: #fff; padding: 40px; border-radius: 12px; border: 2px solid #d69b5c;">
          <div style="text-align: center; margin-bottom: 30px;">
            <img src="https://yallternativeliving.com/assets/img/logo.png" alt="Y'allternative Living Logo" style="max-width: 200px;" />
          </div>
          <h1 style="color: #d69b5c; text-align: center;">Gift Card Fully Redeemed</h1>
          <p style="font-size: 16px;">Your Y'allternative Living gift card (<strong>${promo.code}</strong>) has been fully used ($${spentDollars} applied). Final balance: <strong>$0.00</strong>.</p>
          <p style="font-size: 14px; color: #cfc0a8;">Thank you for shopping with us! We hope you love your handmade goodies.</p>
          <div style="text-align: center; margin-top: 25px;">
            <a href="https://yallternativeliving.com" style="display: inline-block; background: #d69b5c; color: #17130f; text-decoration: none; padding: 12px 24px; font-weight: bold; border-radius: 4px; text-transform: uppercase; letter-spacing: 1px;">Visit Our Shop</a>
          </div>
        </div>
      `;
      text =
        `Your Y'allternative Living gift card (${promo.code}) has been fully redeemed ($${spentDollars} spent).\n` +
        `Final Balance: $0.00.\n\n` +
        `Thank you for supporting small-batch handmade self-care!`;
    }

    const emailIdemp = `gift-balance-email-${session.id}-${promo.code}-${newBalanceCents}`;
    try {
      await resendClient.emails.send(
        {
          from: fromAddress,
          to: targetEmail,
          reply_to: "contact@yallternativeliving.com",
          subject: subject,
          html: html,
          text: text,
          headers: { "X-Entity-Ref-ID": emailIdemp, "Idempotency-Key": emailIdemp }
        },
        { idempotencyKey: emailIdemp }
      );
    } catch (emailErr) {
      console.warn("Failed to send balance update email:", emailErr.message);
    }
  }

  return { code: promo.code, spentCents: amountDiscountCents, newBalanceCents };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  var rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";
  var signatureHeader = event.headers["stripe-signature"] || event.headers["Stripe-Signature"];

  var webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || STRIPE_WEBHOOK_SECRET;
  var stripeEvent;
  try {
    stripeEvent = verifyStripeSignature(rawBody, signatureHeader, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return { statusCode: 400, body: "Invalid signature: " + err.message };
  }

  if (stripeEvent.type !== "checkout.session.completed") {
    return { statusCode: 200, body: "Event ignored" };
  }

  try {
    var session = stripeEvent.data.object;
    var metadata = session.metadata || {};

    // 1. Check for gift card redemption & balance deduction on this session
    await handleGiftCardRedemption(session, STRIPE_SECRET_KEY);

    // 2. Check for gift card purchases in this session
    var giftIndexes = Object.keys(metadata)
      .map(function (k) {
        var m = /^gift_card_(\d+)_amount_cents$/.exec(k);
        return m ? Number(m[1]) : null;
      })
      .filter(function (n) {
        return n !== null;
      });

    if (!giftIndexes.length) {
      return { statusCode: 200, body: "Session processed (no new gift cards purchased)" };
    }

    await Promise.all(
      giftIndexes.map(async function (n) {
        var prefix = "gift_card_" + n;
        var amountCents = Number(metadata[prefix + "_amount_cents"]);
        var recipientEmail = metadata[prefix + "_recipient"];
        var senderName = metadata[prefix + "_sender"];
        var personalMessage = metadata[prefix + "_message"];

        if (!recipientEmail || !Number.isFinite(amountCents) || amountCents <= 0) {
          console.error("Gift card metadata incomplete for session " + session.id + ", index " + n);
          return;
        }

        var uniqueCode = deriveGiftCardCode(session.id, n, webhookSecret);
        var confirmedCode = await createGiftCardPromotionCode(
          session.id,
          n,
          amountCents,
          uniqueCode,
          {
            initial_amount_cents: String(amountCents),
            recipient_email: recipientEmail,
            sender_name: senderName || ""
          }
        );

        var amount = amountCents / 100;
        var safeSender = senderName ? escapeHtml(senderName) : "Someone special";
        var emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #17130f; color: #fff; padding: 40px; border-radius: 12px; border: 2px solid #d69b5c;">
          <div style="text-align: center; margin-bottom: 30px;">
            <img src="https://yallternativeliving.com/assets/img/logo.png" alt="Y'allternative Living Logo" style="max-width: 200px;" />
          </div>
          <h1 style="color: #d69b5c; text-align: center;">You've received a gift!</h1>
          <p style="font-size: 18px;"><strong>${safeSender}</strong> sent you a $${amount.toFixed(2)} gift card to Y'allternative Living.</p>

          ${personalMessage ? `<div style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 8px; font-style: italic; margin: 20px 0;">"${escapeHtml(personalMessage)}"</div>` : ""}

          <div style="text-align: center; background: #fff; color: #000; padding: 20px; border-radius: 8px; margin: 30px 0;">
            <p style="margin: 0; text-transform: uppercase; letter-spacing: 2px; font-size: 14px; color: #666;">Your Gift Code</p>
            <h2 style="margin: 10px 0 0 0; font-size: 32px; letter-spacing: 4px;">${confirmedCode}</h2>
            <p style="margin: 10px 0 0 0; font-size: 13px; color: #666;">Stored-Value Card · Unused balances automatically carry over!</p>
          </div>

          <div style="text-align: center;">
            <a href="https://yallternativeliving.com" style="display: inline-block; background: #d69b5c; color: #17130f; text-decoration: none; padding: 15px 30px; font-weight: bold; border-radius: 4px; text-transform: uppercase; letter-spacing: 1px;">Shop Now</a>
          </div>
        </div>
      `;

        var emailText =
          `${senderName ? senderName : "Someone special"} sent you a $${amount.toFixed(2)} gift card to Y'allternative Living!\n\n` +
          (personalMessage ? `Personal Message:\n"${personalMessage}"\n\n` : "") +
          `Your Gift Code: ${confirmedCode}\n` +
          `Stored-Value Card: Unused balances carry over automatically across purchases!\n\n` +
          `Enter this code at checkout on https://yallternativeliving.com to redeem your gift card.`;

        var resendClient = getResendClient();
        var fromAddress =
          process.env.FROM_EMAIL ||
          process.env.RESEND_FROM_EMAIL ||
          "Y'allternative Living <gifts@yallternativeliving.com>";

        var emailIdempotencyKey = "gift-email-" + session.id + "-" + n;
        var sendResult;
        try {
          sendResult = await resendClient.emails.send(
            {
              from: fromAddress,
              to: recipientEmail,
              reply_to: "contact@yallternativeliving.com",
              subject: `You received a $${amount.toFixed(2)} Y'allternative Living gift card!`,
              html: emailHtml,
              text: emailText,
              headers: {
                "X-Entity-Ref-ID": emailIdempotencyKey,
                "Idempotency-Key": emailIdempotencyKey
              }
            },
            {
              idempotencyKey: emailIdempotencyKey
            }
          );
        } catch (emailErr) {
          console.error(
            `Failed to send gift card email for code ${confirmedCode}:`,
            emailErr.message
          );
          throw new Error(`Email dispatch failed: ${emailErr.message}`);
        }

        if (sendResult && sendResult.error) {
          console.error(
            `Resend API error sending gift card email for code ${confirmedCode}:`,
            sendResult.error
          );
          throw new Error(
            `Resend delivery failed: ${sendResult.error.message || JSON.stringify(sendResult.error)}`
          );
        }

        // Send buyer receipt backup
        var buyerEmail =
          (session.customer_details && session.customer_details.email) || session.customer_email;

        if (buyerEmail && typeof buyerEmail === "string" && buyerEmail.trim()) {
          var cleanBuyer = buyerEmail.trim();
          var isSelfGift = cleanBuyer.toLowerCase() === recipientEmail.trim().toLowerCase();
          var buyerSubject = isSelfGift
            ? `Your $${amount.toFixed(2)} Y'allternative Living gift card is ready!`
            : `Gift Card Sent: $${amount.toFixed(2)} to ${recipientEmail}`;

          var buyerEmailHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #17130f; color: #fff; padding: 40px; border-radius: 12px; border: 2px solid #d69b5c;">
            <div style="text-align: center; margin-bottom: 30px;">
              <img src="https://yallternativeliving.com/assets/img/logo.png" alt="Y'allternative Living Logo" style="max-width: 200px;" />
            </div>
            <h1 style="color: #d69b5c; text-align: center;">Gift Card Confirmation</h1>
            <p style="font-size: 16px;">Thank you for your order! ${isSelfGift ? "Your gift card is ready to use." : `We've emailed your gift card to <strong>${escapeHtml(recipientEmail)}</strong>.`}</p>

            ${personalMessage ? `<div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; font-style: italic; margin: 20px 0;">"${escapeHtml(personalMessage)}"</div>` : ""}

            <div style="text-align: center; background: #fff; color: #000; padding: 20px; border-radius: 8px; margin: 30px 0;">
              <p style="margin: 0; text-transform: uppercase; letter-spacing: 2px; font-size: 13px; color: #666;">Gift Voucher Code (Backup Copy)</p>
              <h2 style="margin: 10px 0 0 0; font-size: 28px; letter-spacing: 4px;">${confirmedCode}</h2>
              <p style="margin: 10px 0 0 0; font-size: 13px; color: #666;">Value: $${amount.toFixed(2)} USD · Stored-Value Balance</p>
            </div>

            <p style="font-size: 13px; color: #aaa; text-align: center;">Keep this email for your records. If your recipient has trouble finding their email, you can share this code directly with them.</p>

            <div style="text-align: center; margin-top: 25px;">
              <a href="https://yallternativeliving.com" style="display: inline-block; background: #d69b5c; color: #17130f; text-decoration: none; padding: 12px 25px; font-weight: bold; border-radius: 4px; text-transform: uppercase; letter-spacing: 1px;">Visit Our Shop</a>
            </div>
          </div>
        `;

          var buyerEmailText =
            `Thank you for your gift card purchase from Y'allternative Living!\n\n` +
            (isSelfGift
              ? `Your gift card is ready to use.`
              : `We've sent the gift card to ${recipientEmail}.`) +
            `\n\n` +
            `Gift Voucher Code (Backup Copy): ${confirmedCode}\n` +
            `Value: $${amount.toFixed(2)} USD\n\n` +
            (personalMessage ? `Personal Message:\n"${personalMessage}"\n\n` : "") +
            `Keep this code for your records or forward it to your recipient if needed.\n` +
            `Redeem at checkout on https://yallternativeliving.com`;

          var buyerIdempotencyKey = "gift-buyer-email-" + session.id + "-" + n;
          try {
            await resendClient.emails.send(
              {
                from: fromAddress,
                to: cleanBuyer,
                reply_to: "contact@yallternativeliving.com",
                subject: buyerSubject,
                html: buyerEmailHtml,
                text: buyerEmailText,
                headers: {
                  "X-Entity-Ref-ID": buyerIdempotencyKey,
                  "Idempotency-Key": buyerIdempotencyKey
                }
              },
              {
                idempotencyKey: buyerIdempotencyKey
              }
            );
          } catch (buyerErr) {
            console.warn("Non-fatal: failed to send buyer confirmation email:", buyerErr.message);
          }
        }
      })
    );

    return { statusCode: 200, body: "Webhook processed successfully" };
  } catch (error) {
    console.error("Webhook processing error:", error);
    return { statusCode: 500, body: "Internal Server Error" };
  }
};

exports.generateRandomCode = generateRandomCode;
exports.deriveGiftCardCode = deriveGiftCardCode;
exports.escapeHtml = escapeHtml;
exports.verifyStripeSignature = verifyStripeSignature;
exports.createGiftCardPromotionCode = createGiftCardPromotionCode;
exports.rolloverGiftCardBalance = rolloverGiftCardBalance;
exports.handleGiftCardRedemption = handleGiftCardRedemption;
exports.findUsedPromotionCode = findUsedPromotionCode;
exports.getResendClient = getResendClient;
