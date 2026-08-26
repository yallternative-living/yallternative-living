/**
 * Netlify Function: gift-card fulfillment webhook.
 *
 * Used to be a Snipcart order.completed webhook that created a Snipcart
 * "Discount" and emailed it. Snipcart is gone (see docs/STRIPE-MIGRATION.md)
 * -- this now listens for Stripe's checkout.session.completed event instead,
 * which is the reliable "actually paid" signal (never the success-page
 * redirect, which a dropped connection can lose -- see workers/checkout.js's
 * own comment on the same point).
 *
 * Flow:
 *   1. workers/checkout.js creates the Stripe Checkout Session and, for any
 *      gift-card line item, writes gift_card_<N>_amount_cents/_recipient/
 *      _sender/_message onto the session's metadata (N is 1-indexed per
 *      gift card in the order, so multiple gift cards in one order don't
 *      collide).
 *   2. Once the customer pays, Stripe POSTs a checkout.session.completed
 *      event here. This handler verifies it's really from Stripe, then for
 *      each gift_card_N_* group: generates a random redemption code, asks
 *      Stripe to create a single-use, fixed-amount Promotion Code for it
 *      (the direct equivalent of the old Snipcart "Discount"), and emails
 *      the code to the recipient via Resend.
 *   3. workers/checkout.js sets allow_promotion_codes: true on every
 *      Checkout Session, so the recipient can enter that code on Stripe's
 *      own hosted checkout page on a future order.
 *
 * Required environment variables (Netlify site settings -> Environment):
 *   - STRIPE_SECRET_KEY      Same restricted/secret key used by the Worker,
 *                            needs Coupon + Promotion Code write access.
 *   - STRIPE_WEBHOOK_SECRET  From the Stripe Dashboard once this function's
 *                            URL is registered as an endpoint listening for
 *                            checkout.session.completed (Developers ->
 *                            Webhooks -> Add endpoint -> signing secret,
 *                            starts with "whsec_").
 *   - RESEND_API_KEY         Already used before this migration.
 *
 * REQUIRED, not just the env vars above: the sending domain
 * (yallternativeliving.com, since emails go out as
 * gifts@yallternativeliving.com below) must be added and verified in
 * Resend's dashboard (Domains -> Add Domain -> add the DNS records it
 * shows -> Verify) before RESEND_API_KEY will actually deliver anything.
 * An unverified domain fails the send silently from the buyer's point of
 * view -- the checkout still completes, the recipient just never gets an
 * email -- and this function only logs that failure (see the catch around
 * resend.emails.send below), it doesn't surface it anywhere a human would
 * see it. See docs/SETUP-GUIDE.md Step 6 / workers/README.md for the
 * full steps.
 *
 * IMPORTANT -- this could not be verified against a live Stripe webhook
 * delivery in the sandboxed dev environment this was built in (no way to
 * receive a real POST from Stripe). Before relying on this in production:
 * register the endpoint in test mode, run a real test-mode Checkout, and
 * confirm the email arrives with a code that actually applies at checkout.
 * The signature-verification scheme below follows Stripe's documented
 * webhook-signing spec (https://stripe.com/docs/webhooks#verify-manually)
 * but a first real delivery is the only way to be certain nothing about
 * Netlify's raw-body handling trips it up.
 */
const { Resend } = require('resend');
const crypto = require('crypto');

const resend = new Resend(process.env.RESEND_API_KEY || 're_test');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Stripe tolerates clock drift but rejects anything older than this to
// block replay of a captured webhook payload.
const WEBHOOK_TOLERANCE_SECONDS = 300;

function generateRandomCode() {
  // crypto.randomInt (CSPRNG) instead of Math.random -- these codes are
  // redeemable money (a single-use discount worth up to $500), so they
  // must not come from a predictable PRNG.
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = 'YALL-';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(crypto.randomInt(chars.length));
  }
  return result;
}

// Deterministic per (session, gift index): a retried webhook delivery
// (Stripe retries on non-2xx or timeout) must send the promotion-code
// request with EXACTLY the same parameters under the same Idempotency-Key
// to get the original code back. A fresh generateRandomCode() on the retry
// put a different `code` param under the reused key, which Stripe rejects
// outright (idempotency_error) -- so a retried delivery could never mint or
// re-fetch the code and the recipient's email was silently skipped. Keyed
// with the webhook signing secret so codes stay unguessable without it.
function deriveGiftCardCode(sessionId, giftIndex, secret) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const digest = crypto
    .createHmac('sha256', String(secret || ''))
    .update('gift-code-' + sessionId + '-' + giftIndex)
    .digest();
  let result = 'YALL-';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(digest[i] % chars.length);
  }
  return result;
}

// Escape user-supplied text before interpolating it into the email HTML.
// Sender Name / Message come straight from checkout metadata (ultimately
// from the buyer's own form input), so without this a buyer could inject
// arbitrary HTML (links, fake buttons, hidden text) into an email that
// lands in someone ELSE's inbox from gifts@yallternativeliving.com -- a
// ready-made phishing vector.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Verify the Stripe-Signature header manually (no stripe SDK dependency,
// matching the rest of this project's zero/minimal-dependency style --
// see workers/checkout.js, which talks to Stripe's REST API directly too).
// Returns the parsed event object if valid, throws otherwise.
function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) throw new Error('Missing Stripe-Signature header');
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');

  var timestamp;
  var v1Signatures = [];
  signatureHeader.split(',').forEach(function (pair) {
    var idx = pair.indexOf('=');
    if (idx === -1) return;
    var key = pair.slice(0, idx).trim();
    var val = pair.slice(idx + 1).trim();
    if (key === 't') timestamp = val;
    if (key === 'v1') v1Signatures.push(val);
  });
  if (!timestamp || !v1Signatures.length) throw new Error('Malformed Stripe-Signature header');

  var age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > WEBHOOK_TOLERANCE_SECONDS) {
    throw new Error('Webhook timestamp outside tolerance -- possible replay');
  }

  var expected = crypto
    .createHmac('sha256', secret)
    .update(timestamp + '.' + rawBody, 'utf8')
    .digest('hex');

  var expectedBuf = Buffer.from(expected, 'utf8');
  var signatureOk = v1Signatures.some(function (sig) {
    var actualBuf = Buffer.from(sig, 'utf8');
    return expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
  });
  if (!signatureOk) throw new Error('Signature mismatch');

  return JSON.parse(rawBody);
}

// Ask Stripe to create a single-use, fixed-amount Promotion Code. Uses an
// idempotency key derived from the session + gift-card index so a retried
// webhook delivery (Stripe retries on non-2xx or timeout) re-fetches the
// SAME code instead of minting a second, orphaned one.
async function createGiftCardPromotionCode(sessionId, giftIndex, amountCents, code) {
  var couponIdempotencyKey = 'gift-coupon-' + sessionId + '-' + giftIndex;
  var couponRes = await fetch('https://api.stripe.com/v1/coupons', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': couponIdempotencyKey,
      // Pinned to match workers/checkout.js -- see the comment there. Without
      // this header, Stripe silently falls back to whatever default version
      // is set in the Dashboard, which Stripe's own docs warn against relying
      // on for exactly this reason (a Dashboard change could alter behavior
      // here with no corresponding code change).
      'Stripe-Version': '2026-06-24.dahlia'
    },
    body: new URLSearchParams({
      amount_off: String(amountCents),
      currency: 'usd',
      duration: 'once',
      max_redemptions: '1',
      name: "Y'allternative Living gift card"
    })
  });
  var coupon = await couponRes.json();
  if (coupon.error) throw new Error('Stripe coupon creation failed: ' + coupon.error.message);

  var promoIdempotencyKey = 'gift-promo-' + sessionId + '-' + giftIndex;
  var promoRes = await fetch('https://api.stripe.com/v1/promotion_codes', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': promoIdempotencyKey,
      'Stripe-Version': '2026-06-24.dahlia'
    },
    body: new URLSearchParams({
      coupon: coupon.id,
      code: code,
      max_redemptions: '1'
    })
  });
  var promo = await promoRes.json();
  if (promo.error) throw new Error('Stripe promotion code creation failed: ' + promo.error.message);

  return promo.code;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  var rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body || '';
  var signatureHeader =
    event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

  var stripeEvent;
  try {
    stripeEvent = verifyStripeSignature(rawBody, signatureHeader, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: 'Invalid signature: ' + err.message };
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'Event ignored' };
  }

  try {
    var session = stripeEvent.data.object;
    var metadata = session.metadata || {};

    // Collect gift_card_<N>_* groups out of the flat metadata object --
    // there's no fixed upper bound on N (see workers/checkout.js's
    // giftLineIndex), so scan for every _amount_cents key present.
    var giftIndexes = Object.keys(metadata)
      .map(function (k) {
        var m = /^gift_card_(\d+)_amount_cents$/.exec(k);
        return m ? Number(m[1]) : null;
      })
      .filter(function (n) {
        return n !== null;
      });

    if (!giftIndexes.length) {
      return { statusCode: 200, body: 'No gift cards in this session' };
    }

    await Promise.all(
      giftIndexes.map(async function (n) {
        var prefix = 'gift_card_' + n;
        var amountCents = Number(metadata[prefix + '_amount_cents']);
        var recipientEmail = metadata[prefix + '_recipient'];
        var senderName = metadata[prefix + '_sender'];
        var personalMessage = metadata[prefix + '_message'];

        if (!recipientEmail || !Number.isFinite(amountCents) || amountCents <= 0) {
          console.error(
            'Gift card metadata incomplete for session ' + session.id + ', index ' + n
          );
          return;
        }

        var uniqueCode = deriveGiftCardCode(session.id, n, STRIPE_WEBHOOK_SECRET);
        var confirmedCode;
        try {
          confirmedCode = await createGiftCardPromotionCode(session.id, n, amountCents, uniqueCode);
        } catch (err) {
          console.error('Failed to create promotion code:', err.message);
          return; // don't let one bad gift card in a multi-item order block the rest
        }

        var amount = amountCents / 100;
        var emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #17130f; color: #fff; padding: 40px; border-radius: 12px; border: 2px solid #d69b5c;">
          <div style="text-align: center; margin-bottom: 30px;">
            <img src="https://yallternativeliving.com/assets/img/logo.png" alt="Y'allternative Living Logo" style="max-width: 200px;" />
          </div>
          <h1 style="color: #d69b5c; text-align: center;">You've received a gift!</h1>
          <p style="font-size: 18px;"><strong>${senderName ? escapeHtml(senderName) : 'Someone special'}</strong> sent you a $${amount.toFixed(2)} gift card to Y'allternative Living.</p>

          ${personalMessage ? `<div style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 8px; font-style: italic; margin: 20px 0;">"${escapeHtml(personalMessage)}"</div>` : ''}

          <div style="text-align: center; background: #fff; color: #000; padding: 20px; border-radius: 8px; margin: 30px 0;">
            <p style="margin: 0; text-transform: uppercase; letter-spacing: 2px; font-size: 14px; color: #666;">Your Gift Code</p>
            <h2 style="margin: 10px 0 0 0; font-size: 32px; letter-spacing: 4px;">${confirmedCode}</h2>
            <p style="margin: 10px 0 0 0; font-size: 13px; color: #666;">Enter this code at checkout to redeem it.</p>
          </div>

          <div style="text-align: center;">
            <a href="https://yallternativeliving.com" style="display: inline-block; background: #d69b5c; color: #17130f; text-decoration: none; padding: 15px 30px; font-weight: bold; border-radius: 4px; text-transform: uppercase; letter-spacing: 1px;">Shop Now</a>
          </div>
        </div>
      `;

        try {
          await resend.emails.send({
            from: 'gifts@yallternativeliving.com',
            to: recipientEmail,
            subject: `You received a $${amount.toFixed(2)} Y'allternative Living gift card!`,
            html: emailHtml,
            headers: {
              'X-Entity-Ref-ID': 'gift-email-' + session.id + '-' + n
            }
          });
        } catch (emailErr) {
          console.error(`Failed to send gift card email for code ${confirmedCode}:`, emailErr.message);
        }
      })
    );

    return { statusCode: 200, body: 'Webhook processed successfully' };
  } catch (error) {
    console.error('Webhook processing error:', error);
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};

exports.generateRandomCode = generateRandomCode;
exports.deriveGiftCardCode = deriveGiftCardCode;
exports.escapeHtml = escapeHtml;
exports.verifyStripeSignature = verifyStripeSignature;
exports.createGiftCardPromotionCode = createGiftCardPromotionCode;

