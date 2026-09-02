/**
 * @fileoverview Gift-card codes and the emails that carry them.
 *
 * WHAT CHANGED, AND WHY IT MATTERS
 * A gift card used to BE a Stripe Promotion Code: the balance was the coupon's
 * `amount_off`, and spending it meant deactivating one promotion code and
 * minting a replacement carrying the remainder ("rollover"). That is the shape
 * audit C-2 grew out of -- Stripe has no reserve-then-settle primitive for
 * stored value, so two tabs both read the full balance, both got a discount,
 * and nothing was ever debited.
 *
 * A code is now nothing but a NAME for a row in the GiftCardLedger Durable
 * Object (workers/state/gift-card-ledger.js), which is strongly consistent and
 * serialises every mutation for that code. Stripe never holds a balance again:
 * a redemption mints a single-use ephemeral coupon for the amount the ledger
 * agreed to hold, and that is all. There is no rollover, no promotion code per
 * card, and no second place a balance can be wrong.
 *
 * CODE FORMAT
 * `YALL-XXXX-XXXX-XXXX` -- 12 characters over a 32-symbol alphabet, so 32^12 ~=
 * 1.15e18 codes. The old format was 8 characters over 36 with modulo bias
 * (audit, Medium/Payments), i.e. ~2.8e12 with some codes far likelier than
 * others; the ledger makes a balance real, which makes guessing worth doing.
 * The alphabet is Crockford's base32: no I, L, O or U, so a handwritten code
 * cannot be read back wrong and the set cannot spell anything unfortunate.
 *
 * Being 2^5 symbols is not a coincidence either -- see randomGiftCardCode.
 */

import { escapeHtml } from "./http.js";

/**
 * Crockford base32. Exactly 32 symbols: I/L/O are dropped as look-alikes of
 * 1/1/0 and U is dropped so no code can spell an obscenity.
 */
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 12;
export const CODE_PREFIX = "YALL";

/** Accepts the canonical grouped form and the same 12 characters typed flat. */
const GROUPED_RE = /^YALL-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
const FLAT_RE = /^YALL-([0-9A-Z]{12})$/;

/** `YALL-XXXXXXXXXXXX` -> `YALL-XXXX-XXXX-XXXX`. */
export function formatGiftCardCode(body) {
  const chars = String(body).toUpperCase();
  return `${CODE_PREFIX}-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

/**
 * Is this string shaped like one of our codes? Format is checked BEFORE any
 * lookup, so a malformed guess costs no Durable Object request and cannot be
 * used to measure how long a real lookup takes.
 *
 * The legacy `YALL-[A-Z0-9]{6,16}` shape is still accepted because
 * workers/state/gift-card-ledger.js's `normalizeCode` accepts it and the two
 * must not disagree about what a code is. No code in that shape was ever
 * issued -- the ledger ships with an empty world -- so this is only about the
 * two files agreeing.
 */
export function isGiftCardCode(value) {
  if (typeof value !== "string") return false;
  const clean = value.trim().toUpperCase().replace(/\s+/g, "");
  return (
    GROUPED_RE.test(clean) || FLAT_RE.test(clean) || /^YALL-(?:PTS-)?[A-Z0-9]{6,16}$/.test(clean)
  );
}

/**
 * A fresh random code.
 *
 * Unbiased by construction. The old `digest[i] % 36` gave the first four
 * symbols of a 36-symbol alphabet a 8/256 chance against 7/256 for the rest --
 * small, but it is exactly the sort of skew that shrinks a search. Here the
 * alphabet is 32 symbols and 256 is a whole multiple of 32, so every byte maps
 * to exactly one symbol with equal probability.
 *
 * The rejection-sampling loop is kept even though it can never reject at 32
 * symbols: it is what makes the function still correct if the alphabet is ever
 * changed to a size that does not divide 256. `limit` is the largest multiple
 * of the alphabet size that fits in a byte; anything at or above it would fold
 * unevenly and is drawn again.
 */
export function randomGiftCardCode(getRandomValues) {
  const rng = getRandomValues || ((array) => crypto.getRandomValues(array)); /* WebCrypto CSPRNG */
  const size = CODE_ALPHABET.length;
  const limit = Math.floor(256 / size) * size;
  let out = "";
  while (out.length < CODE_LENGTH) {
    const bytes = new Uint8Array(CODE_LENGTH);
    rng(bytes);
    for (const byte of bytes) {
      if (out.length === CODE_LENGTH) break;
      if (byte >= limit) continue; // would be biased -- draw again
      out += CODE_ALPHABET[byte % size];
    }
  }
  return formatGiftCardCode(out);
}

/**
 * The code for one purchased gift-card UNIT, derived rather than drawn.
 *
 * Stripe delivers `checkout.session.completed` at least once and retries for
 * about three days. A random code would mint a different card on every
 * redelivery, so the code is an HMAC of (session id, unit key) under the
 * webhook signing secret: the same delivery always derives the same string,
 * `ledger.issue()` sees a byte-identical re-issue and no-ops, and the buyer
 * gets one card rather than four.
 *
 * The signing secret is the key because it is already required for this webhook
 * to be processed at all and it never leaves Cloudflare -- deriving from the
 * session id alone would let anyone who saw a `cs_…` in a URL compute the code.
 *
 * Same unbiased mapping as above: 256 is a whole multiple of 32, so `byte % 32`
 * is exactly `byte & 31` and every symbol is equally likely.
 *
 * @param {string} sessionId Stripe Checkout Session id
 * @param {string} unitKey   "<line index>-<unit number>", stable per unit
 * @param {string} secret    STRIPE_WEBHOOK_SECRET
 */
export async function deriveGiftCardCode(sessionId, unitKey, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(secret || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`gift-code-${sessionId}-${unitKey}`)
  );
  const bytes = new Uint8Array(signature);
  const size = CODE_ALPHABET.length;
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % size];
  return formatGiftCardCode(out);
}

/**
 * Expand the `gift_card_N_*` metadata groups on a session into one entry per
 * card actually bought.
 *
 * One metadata GROUP per gift-card LINE, carrying its quantity -- not one group
 * per unit. Stripe caps a session at 50 metadata keys and silently rejects the
 * request past that, so the old per-unit expansion made a 13-card order fail
 * outright (audit H-8). The expansion happens here instead, where there is no
 * cap.
 *
 * `unitKey` is what feeds the code derivation, so it must be stable across
 * redeliveries: it is always `<line>-<unit>`, never a running counter.
 */
export function giftCardUnitsFrom(metadata) {
  const meta = metadata || {};
  const lines = Object.keys(meta)
    .map((k) => {
      const m = /^gift_card_(\d+)_amount_cents$/.exec(k);
      return m ? Number(m[1]) : null;
    })
    .filter((n) => n !== null)
    .sort((a, b) => a - b);

  const units = [];
  for (const n of lines) {
    const prefix = `gift_card_${n}`;
    const parsedQty = parseInt(meta[`${prefix}_qty`], 10);
    const qty = Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1;
    for (let q = 1; q <= qty; q++) {
      units.push({
        unitKey: `${n}-${q}`,
        amountCents: Number(meta[`${prefix}_amount_cents`]),
        recipientEmail: meta[`${prefix}_recipient`],
        senderName: meta[`${prefix}_sender`],
        personalMessage: meta[`${prefix}_message`]
      });
    }
  }
  return units;
}

/* ------------------------------------------------------------------ email */

const DEFAULT_FROM = "Y'allternative Living <gifts@yallternativeliving.com>";

export function fromAddress(env) {
  return env.GIFT_CARD_FROM_EMAIL || env.RESEND_FROM_EMAIL || env.FROM_EMAIL || DEFAULT_FROM;
}

/**
 * Send one email through Resend.
 *
 * A plain fetch, not the SDK: `resend` is a Node package and this is a Worker.
 *
 * `idempotencyKey` is passed both as Resend's own `Idempotency-Key` header and
 * as `X-Entity-Ref-ID`, exactly as the retired Netlify function did, so a
 * redelivered webhook cannot send a second copy of a gift card.
 *
 * @returns {Promise<{ok: boolean, status: number}>} never throws for a refusal;
 *   the caller decides whether an unsent email should fail the webhook.
 */
export async function sendEmail(env, message, idempotencyKey) {
  if (!env.RESEND_API_KEY) {
    // Refusing to pretend. The old default of a literal "re_test" key made a
    // missing configuration look healthy: the send failed, the failure was
    // logged as a warning, and the webhook still returned 200 (audit H-9).
    throw new Error("RESEND_API_KEY is not configured");
  }
  // A caller's own `message.headers` are MERGED, not replaced. The retention
  // sends put `List-Unsubscribe` and `List-Unsubscribe-Post` there, and an
  // earlier version of this function overwrote the whole object with the
  // idempotency pair -- which would have silently dropped the one header a
  // marketing email is required to carry.
  const messageHeaders = {
    ...(message && message.headers ? message.headers : {}),
    ...(idempotencyKey
      ? { "X-Entity-Ref-ID": idempotencyKey, "Idempotency-Key": idempotencyKey }
      : {})
  };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
    },
    body: JSON.stringify({
      ...message,
      headers: Object.keys(messageHeaders).length ? messageHeaders : undefined
    })
  });
  return { ok: Boolean(res && res.ok), status: res ? res.status : 502 };
}

/** The card itself, to the person it was bought for. */
export function recipientEmailBody(code, amountCents, senderName, personalMessage) {
  const amount = (amountCents / 100).toFixed(2);
  const safeSender = senderName ? escapeHtml(senderName) : "Someone special";
  const safeCode = escapeHtml(code);
  const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #17130f; color: #fff; padding: 40px; border-radius: 12px; border: 2px solid #d69b5c;">
          <div style="text-align: center; margin-bottom: 30px;">
            <img src="https://yallternativeliving.com/assets/img/logo.png" alt="Y'allternative Living Logo" style="max-width: 200px;" />
          </div>
          <h1 style="color: #d69b5c; text-align: center;">You've received a gift!</h1>
          <p style="font-size: 18px;"><strong>${safeSender}</strong> sent you a $${amount} gift card to Y'allternative Living.</p>

          ${personalMessage ? `<div style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 8px; font-style: italic; margin: 20px 0;">"${escapeHtml(personalMessage)}"</div>` : ""}

          <div style="text-align: center; background: #fff; color: #000; padding: 20px; border-radius: 8px; margin: 30px 0;">
            <p style="margin: 0; text-transform: uppercase; letter-spacing: 2px; font-size: 14px; color: #666;">Your Gift Code</p>
            <h2 style="margin: 10px 0 0 0; font-size: 32px; letter-spacing: 4px;">${safeCode}</h2>
            <p style="margin: 10px 0 0 0; font-size: 13px; color: #666;">Stored-Value Card · Unused balances automatically carry over!</p>
          </div>

          <div style="text-align: center;">
            <a href="https://yallternativeliving.com" style="display: inline-block; background: #d69b5c; color: #17130f; text-decoration: none; padding: 15px 30px; font-weight: bold; border-radius: 4px; text-transform: uppercase; letter-spacing: 1px;">Shop Now</a>
          </div>
        </div>
      `;
  const text =
    `${senderName ? senderName : "Someone special"} sent you a $${amount} gift card to Y'allternative Living!\n\n` +
    (personalMessage ? `Personal Message:\n"${personalMessage}"\n\n` : "") +
    `Your Gift Code: ${code}\n` +
    `Stored-Value Card: Unused balances carry over automatically across purchases!\n\n` +
    `Enter this code at checkout on https://yallternativeliving.com to redeem your gift card.`;
  return {
    subject: `You received a $${amount} Y'allternative Living gift card!`,
    html,
    text
  };
}

/** The buyer's backup copy, so a mistyped recipient address is recoverable. */
export function buyerEmailBody(code, amountCents, recipient, personalMessage, isSelfGift) {
  const amount = (amountCents / 100).toFixed(2);
  const safeCode = escapeHtml(code);
  const html = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #17130f; color: #fff; padding: 40px; border-radius: 12px; border: 2px solid #d69b5c;">
            <div style="text-align: center; margin-bottom: 30px;">
              <img src="https://yallternativeliving.com/assets/img/logo.png" alt="Y'allternative Living Logo" style="max-width: 200px;" />
            </div>
            <h1 style="color: #d69b5c; text-align: center;">Gift Card Confirmation</h1>
            <p style="font-size: 16px;">Thank you for your order! ${isSelfGift ? "Your gift card is ready to use." : `We've emailed your gift card to <strong>${escapeHtml(recipient)}</strong>.`}</p>

            ${personalMessage ? `<div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; font-style: italic; margin: 20px 0;">"${escapeHtml(personalMessage)}"</div>` : ""}

            <div style="text-align: center; background: #fff; color: #000; padding: 20px; border-radius: 8px; margin: 30px 0;">
              <p style="margin: 0; text-transform: uppercase; letter-spacing: 2px; font-size: 13px; color: #666;">Gift Voucher Code (Backup Copy)</p>
              <h2 style="margin: 10px 0 0 0; font-size: 28px; letter-spacing: 4px;">${safeCode}</h2>
              <p style="margin: 10px 0 0 0; font-size: 13px; color: #666;">Value: $${amount} USD · Stored-Value Balance</p>
            </div>

            <p style="font-size: 13px; color: #aaa; text-align: center;">Keep this email for your records. If your recipient has trouble finding their email, you can share this code directly with them.</p>

            <div style="text-align: center; margin-top: 25px;">
              <a href="https://yallternativeliving.com" style="display: inline-block; background: #d69b5c; color: #17130f; text-decoration: none; padding: 12px 25px; font-weight: bold; border-radius: 4px; text-transform: uppercase; letter-spacing: 1px;">Visit Our Shop</a>
            </div>
          </div>
        `;
  const text =
    `Thank you for your gift card purchase from Y'allternative Living!\n\n` +
    (isSelfGift ? `Your gift card is ready to use.` : `We've sent the gift card to ${recipient}.`) +
    `\n\n` +
    `Gift Voucher Code (Backup Copy): ${code}\n` +
    `Value: $${amount} USD\n\n` +
    (personalMessage ? `Personal Message:\n"${personalMessage}"\n\n` : "") +
    `Keep this code for your records or forward it to your recipient if needed.\n` +
    `Redeem at checkout on https://yallternativeliving.com`;
  return {
    subject: isSelfGift
      ? `Your $${amount} Y'allternative Living gift card is ready!`
      : `Gift Card Sent: $${amount} to ${recipient}`,
    html,
    text
  };
}

/** "You spent $X, $Y is left" -- sent after a paid order that used a card. */
export function balanceUpdateEmailBody(code, spentCents, remainingCents) {
  const spent = (spentCents / 100).toFixed(2);
  const remaining = (remainingCents / 100).toFixed(2);
  const safeCode = escapeHtml(code);
  if (remainingCents > 0) {
    return {
      subject: `Gift Card Balance Update: $${remaining} remaining on ${code}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #17130f; color: #fff; padding: 40px; border-radius: 12px; border: 2px solid #d69b5c;">
          <div style="text-align: center; margin-bottom: 30px;">
            <img src="https://yallternativeliving.com/assets/img/logo.png" alt="Y'allternative Living Logo" style="max-width: 200px;" />
          </div>
          <h1 style="color: #d69b5c; text-align: center;">Gift Card Balance Update</h1>
          <p style="font-size: 16px;">You used <strong>$${spent}</strong> from your gift card on your recent order.</p>

          <div style="text-align: center; background: #fff; color: #000; padding: 24px; border-radius: 8px; margin: 25px 0;">
            <p style="margin: 0; text-transform: uppercase; letter-spacing: 2px; font-size: 12px; color: #666;">Remaining Available Balance</p>
            <h2 style="margin: 8px 0; font-size: 36px; color: #17130f; letter-spacing: 1px;">$${remaining}</h2>
            <p style="margin: 4px 0 0 0; font-size: 14px; font-weight: bold; letter-spacing: 2px; color: #333;">Code: ${safeCode}</p>
          </div>

          <p style="font-size: 14px; color: #cfc0a8; line-height: 1.5;">Your gift code <strong>${safeCode}</strong> remains active and will carry over to future orders until your balance reaches $0.00.</p>

          <div style="text-align: center; margin-top: 30px;">
            <a href="https://yallternativeliving.com/shop.html" style="display: inline-block; background: #d69b5c; color: #17130f; text-decoration: none; padding: 14px 28px; font-weight: bold; border-radius: 4px; text-transform: uppercase; letter-spacing: 1px;">Shop The Collection</a>
          </div>
        </div>
      `,
      text:
        `Y'allternative Living Gift Card Balance Update\n\n` +
        `You spent $${spent} on your recent order.\n` +
        `Remaining Balance: $${remaining}\n` +
        `Gift Code: ${code}\n\n` +
        `Your code remains active and can be redeemed on your next order at https://yallternativeliving.com`
    };
  }
  return {
    subject: `Gift Card Fully Redeemed: ${code}`,
    html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #17130f; color: #fff; padding: 40px; border-radius: 12px; border: 2px solid #d69b5c;">
          <div style="text-align: center; margin-bottom: 30px;">
            <img src="https://yallternativeliving.com/assets/img/logo.png" alt="Y'allternative Living Logo" style="max-width: 200px;" />
          </div>
          <h1 style="color: #d69b5c; text-align: center;">Gift Card Fully Redeemed</h1>
          <p style="font-size: 16px;">Your Y'allternative Living gift card (<strong>${safeCode}</strong>) has been fully used ($${spent} applied). Final balance: <strong>$0.00</strong>.</p>
          <p style="font-size: 14px; color: #cfc0a8;">Thank you for shopping with us! We hope you love your handmade goodies.</p>
          <div style="text-align: center; margin-top: 25px;">
            <a href="https://yallternativeliving.com" style="display: inline-block; background: #d69b5c; color: #17130f; text-decoration: none; padding: 12px 24px; font-weight: bold; border-radius: 4px; text-transform: uppercase; letter-spacing: 1px;">Visit Our Shop</a>
          </div>
        </div>
      `,
    text:
      `Your Y'allternative Living gift card (${code}) has been fully redeemed ($${spent} spent).\n` +
      `Final Balance: $0.00.\n\n` +
      `Thank you for supporting small-batch handmade self-care!`
  };
}

/** "A refund put $X back on your card." */
export function refundEmailBody(code, restoredCents, balanceCents) {
  const restored = (restoredCents / 100).toFixed(2);
  const balance = (balanceCents / 100).toFixed(2);
  return {
    subject: `Gift Card Balance Restored: $${restored} added back to ${code}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #17130f; color: #fff; padding: 40px; border-radius: 12px; border: 2px solid #d69b5c;">
        <div style="text-align: center; margin-bottom: 30px;">
          <img src="https://yallternativeliving.com/assets/img/logo.png" alt="Y'allternative Living Logo" style="max-width: 200px;" />
        </div>
        <h1 style="color: #d69b5c; text-align: center;">Gift Card Balance Restored</h1>
        <p style="font-size: 16px;">An order refund has been processed. <strong>$${restored}</strong> has been added back to your gift card.</p>
        <div style="text-align: center; background: #fff; color: #000; padding: 24px; border-radius: 8px; margin: 25px 0;">
          <p style="margin: 0; text-transform: uppercase; letter-spacing: 2px; font-size: 12px; color: #666;">Available Balance</p>
          <h2 style="margin: 8px 0; font-size: 36px; color: #17130f; letter-spacing: 1px;">$${balance}</h2>
          <p style="margin: 4px 0 0 0; font-size: 14px; font-weight: bold; letter-spacing: 2px; color: #333;">Code: ${escapeHtml(code)}</p>
        </div>
        <p style="font-size: 14px; color: #cfc0a8;">Your code remains active and ready for your next order.</p>
      </div>
    `,
    text: `Your gift card balance on ${code} has been restored by $${restored}. Total available balance: $${balance}.`
  };
}
