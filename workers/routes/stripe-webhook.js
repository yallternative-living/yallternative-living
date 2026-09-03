/**
 * @fileoverview POST /api/stripe-webhook -- the only place an order becomes
 * real.
 *
 * Replaces netlify/functions/fulfill-gift-card.js. Three findings shaped it:
 *
 * H-9 (a sub-step failure blocked everything). The old handler ran the
 * redemption rollover and the gift-card minting in ONE try: a rollover error
 * 500'd the whole webhook, Stripe retried forever, and codes the buyer had paid
 * for were never emailed. Each step now runs in its own try/catch and records
 * its failure; the handler still returns non-2xx at the end if anything failed,
 * so Stripe retries -- but the steps that DID work are not re-run for nothing,
 * because every one of them is idempotent.
 *
 * H-5 (refunds). The old code read `gift_card_*` metadata off the CHARGE, where
 * it has never existed, so no refund ever restored a balance; and it restored
 * the full applied amount on every delivery, so wiring it up would have minted
 * money. The session is found from the charge's payment_intent, restoration is
 * capped at what was actually refunded, and only the difference not already
 * restored for that charge is credited.
 *
 * Exactly-once (H-9 again). Stripe delivers at least once and retries for about
 * three days. `claimEvent` writes the event id to D1 with INSERT OR IGNORE
 * BEFORE any side effect: the first delivery gets the claim, every redelivery
 * gets an immediate 200 and does nothing. A handler that throws releases its
 * own claim so the retry can pick the work up again.
 *
 * PROMOTION CODES ARE NOT READ AT ALL. A gift card is a ledger row now, not a
 * Stripe coupon, so there is no rollover, no `session.discounts` inspection and
 * no `YALL-` promotion code to find. `allow_promotion_codes` on the hosted page
 * is for marketing codes only, and this file deliberately ignores them: a
 * marketing discount is Stripe's business, not the ledger's.
 */

import { json } from "./http.js";
import { deleteCoupon, findSessionByPaymentIntent } from "./stripe.js";
import {
  balanceUpdateEmailBody,
  buyerEmailBody,
  deriveGiftCardCode,
  fromAddress,
  giftCardUnitsFrom,
  recipientEmailBody,
  refundEmailBody,
  sendEmail
} from "./gift-cards.js";
import { giftCardLedger, LedgerError } from "../state/gift-card-ledger.js";
import {
  creditLoyaltyForOrder,
  scheduleOrderSequence,
  scheduleRecoveryEmail
} from "./retention-emails.js";
import { recordOrder } from "../state/retention.js";
import { giftNoteLink, giftNotesOf } from "./gift-note.js";
import { loadOrderCatalog, productsNeedingChoice, sizeConfirmationEmail } from "./order-digest.js";
import { loadSiteSettings } from "../state/site-data.js";
import { claimEvent, markEventDone, releaseEvent } from "../state/webhook-events.js";
import { ensureSchema } from "../state/migrations.js";
import { buildOrderPaidPayload, sendToUmami } from "./analytics.js";
import { claimAnalyticsSend, ORDER_PAID, releaseAnalyticsSend } from "../state/analytics-sends.js";

/** Stripe tolerates clock drift but nothing older than this, to block replay. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const REPLY_TO = "contact@yallternativeliving.com";

// Logged once per isolate when the optional D1 claim table is not bound.
let warnedNoStateDb = false;

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/**
 * Verify the `Stripe-Signature` header and return the parsed event.
 *
 * Ported from the Netlify function, with Node's `crypto.timingSafeEqual`
 * replaced by WebCrypto's `subtle.verify` -- which compares the MAC internally
 * and in constant time, so there is no hand-rolled comparison to get wrong.
 *
 * Throws (never returns false) so the caller cannot accidentally treat a
 * refusal as a pass. The caller must NOT echo the reason: telling an
 * unauthenticated poster whether the header was missing, malformed, stale or
 * simply wrong is a free oracle for probing the verification.
 */
export async function verifyStripeSignature(rawBody, signatureHeader, secret, now = Date.now()) {
  if (!signatureHeader) throw new Error("Missing Stripe-Signature header");
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");

  let timestamp = null;
  const v1Signatures = [];
  for (const pair of String(signatureHeader).split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key === "t") timestamp = value;
    if (key === "v1") v1Signatures.push(value);
  }
  if (!timestamp || !v1Signatures.length) throw new Error("Malformed Stripe-Signature header");

  const age = Math.abs(Math.floor(now / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > WEBHOOK_TOLERANCE_SECONDS) {
    throw new Error("Webhook timestamp outside tolerance -- possible replay");
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signed = encoder.encode(`${timestamp}.${rawBody}`);

  let ok = false;
  for (const candidate of v1Signatures) {
    const bytes = hexToBytes(candidate);
    if (!bytes) continue;
    // No early break: every candidate costs the same work either way.
    if (await crypto.subtle.verify("HMAC", key, bytes, signed)) ok = true;
  }
  if (!ok) throw new Error("Signature mismatch");

  return JSON.parse(rawBody);
}

/* ------------------------------------------------------------- handlers */

/**
 * A gift order gets the owner an email with the signed link to the printable
 * gift note (routes/gift-note.js). Nothing is sent when the order carries no
 * gift text, and nothing can be signed without MAGIC_LINK_SECRET -- in that
 * case the note is still readable on the order in Stripe.
 */
export async function emailGiftNoteLink(session, env) {
  const notes = giftNotesOf(session);
  if (!notes.length) return null;
  if (!env || !env.MAGIC_LINK_SECRET) {
    console.error("gift-note: MAGIC_LINK_SECRET is not set; no print link emailed for", session.id);
    return { skipped: "no-secret" };
  }
  const to = env.ORDER_NOTIFY_EMAIL || env.RESTOCK_NOTIFY_EMAIL || REPLY_TO;
  const siteOrigin = env.SITE_ORIGIN || "https://yallternativeliving.com";
  const link = await giftNoteLink(env.MAGIC_LINK_SECRET, session.id, siteOrigin);
  const count = notes.length;
  const subject = `Gift note to print -- order ${session.id}`;
  const text =
    `A gift order just came through with ${count} ${count === 1 ? "note" : "notes"} to print.\n\n` +
    `Open this link, press Print, and slip the card into the parcel:\n${link}\n\n` +
    `The link works for six months and can be printed more than once. The note is also on the order in Stripe.`;
  const html =
    `<p>A gift order just came through with ${count} ${count === 1 ? "note" : "notes"} to print.</p>` +
    `<p><a href="${link}">Open the printable gift note</a>, press Print, and slip the card into the parcel.</p>` +
    `<p style="color:#6b5f52;font-size:13px;">The link works for six months and can be printed more than once. The note is also on the order in Stripe.</p>`;
  await sendEmail(
    env,
    { from: fromAddress(env), to, reply_to: REPLY_TO, subject, text, html },
    `gift-note-email-${session.id}`
  );
  return { emailed: to, notes: count };
}

/**
 * A bundle or a build-your-own box can contain something that comes in more
 * than one size or scent, and neither line lets the shopper pick one: the
 * option is only ever recorded for a plain product line (see checkout.js's
 * findVariantOption). Left alone that becomes a guess at the bench, or a DM
 * days later. This asks, once, while the order is fresh.
 *
 * Transactional -- a question about an order already paid for -- so there is
 * deliberately no unsubscribe link and no suppression check: it is not
 * marketing, and someone who unsubscribed from the newsletter still needs to
 * be asked what size they want.
 *
 * Sends NOTHING for a plain order, for an order whose bundle contents have no
 * variants at all, or when the catalogue is unreachable (an empty index yields
 * an empty list). `size-confirm-<session>` is the Resend idempotency key, so a
 * redelivered webhook asks once.
 */
export async function emailSizeConfirmation(session, env, ctx) {
  const catalog = await loadOrderCatalog(env, ctx);
  const pending = productsNeedingChoice(session, catalog);
  if (!pending.length) return null;
  const to = buyerEmailOf(session);
  if (!to) return { skipped: "no-buyer-email" };

  const site = await loadSiteSettings(env, ctx);
  const automations =
    (site.automations && typeof site.automations === "object" && site.automations) || {};
  const body = sizeConfirmationEmail(pending, automations.sizeConfirmationIntro);
  const delivery = await sendEmail(
    env,
    { from: fromAddress(env), to, reply_to: REPLY_TO, ...body },
    `size-confirm-${session.id}`
  );
  return { emailed: to, products: pending.map((p) => p.id), ok: delivery.ok };
}

function buyerEmailOf(session) {
  const email =
    (session.customer_details && session.customer_details.email) || session.customer_email;
  return typeof email === "string" && email.trim() ? email.trim() : null;
}

/**
 * The card the shopper spent, settled.
 *
 * The reservation was taken when the session was created (see
 * applyGiftCard in workers/checkout.js); paying turns it into a permanent
 * debit. `commit` is idempotent, so a redelivery moves no money.
 *
 * A missing reservation is logged and NOT retried. It means the money was
 * discounted without a hold -- which this code path cannot produce, since a
 * failed hold expires the session before anyone can pay it -- and retrying
 * forever would only bury the anomaly under three days of 500s.
 */
async function settleRedemption(session, env) {
  const metadata = session.metadata || {};
  const code = metadata.gift_card_redeemed_code;
  const appliedCents = Number(metadata.gift_card_amount_applied_cents || 0);
  if (!code || !(appliedCents > 0)) return null;

  const ledger = giftCardLedger(env, code);
  let committed;
  try {
    committed = await ledger.commit({ sessionId: session.id });
  } catch (err) {
    if (err instanceof LedgerError && err.code === "reservation_not_found") {
      console.error(
        `Gift card ${code} was applied to ${session.id} with no reservation on the ledger`
      );
      return null;
    }
    throw err;
  }
  if (committed.alreadyCommitted) return committed;

  const snapshot = await ledger.getBalance();
  const to = snapshot.recipientEmail || buyerEmailOf(session);
  if (to) {
    const body = balanceUpdateEmailBody(ledger.code, committed.cents, snapshot.balanceCents);
    await sendEmail(
      env,
      { from: fromAddress(env), to, reply_to: REPLY_TO, ...body },
      `gift-balance-email-${session.id}-${ledger.code}`
    );
  }
  return committed;
}

/**
 * Cards bought in this order: minted on the ledger and emailed.
 *
 * The code is DERIVED, not drawn (see deriveGiftCardCode), so a redelivery
 * re-derives the same string, `issue` no-ops on it, and Resend's idempotency
 * key suppresses the duplicate email. One retry therefore cannot turn one
 * purchased card into two.
 */
async function issuePurchasedCards(session, env) {
  const units = giftCardUnitsFrom(session.metadata);
  if (!units.length) return [];

  const buyer = buyerEmailOf(session);
  const issued = [];
  for (const unit of units) {
    if (!unit.recipientEmail || !Number.isFinite(unit.amountCents) || unit.amountCents <= 0) {
      console.error(`Gift card metadata incomplete for ${session.id}, unit ${unit.unitKey}`);
      continue;
    }
    const code = await deriveGiftCardCode(session.id, unit.unitKey, env.STRIPE_WEBHOOK_SECRET);
    await giftCardLedger(env, code).issue({
      initialCents: unit.amountCents,
      recipientEmail: unit.recipientEmail,
      source: "checkout"
    });

    const recipientBody = recipientEmailBody(
      code,
      unit.amountCents,
      unit.senderName,
      unit.personalMessage
    );
    const delivery = await sendEmail(
      env,
      {
        from: fromAddress(env),
        to: unit.recipientEmail,
        reply_to: REPLY_TO,
        ...recipientBody
      },
      `gift-email-${session.id}-${unit.unitKey}`
    );
    if (!delivery.ok) {
      // The card exists on the ledger and nobody has been told its code. That
      // is worth a retry, so it throws.
      throw new Error(`Resend refused the gift-card email for ${session.id}/${unit.unitKey}`);
    }

    if (buyer) {
      const isSelfGift = buyer.toLowerCase() === String(unit.recipientEmail).trim().toLowerCase();
      const backup = buyerEmailBody(
        code,
        unit.amountCents,
        unit.recipientEmail,
        unit.personalMessage,
        isSelfGift
      );
      try {
        // Non-fatal: the recipient already has the card. A failed backup copy
        // must not put the whole webhook into Stripe's retry loop.
        await sendEmail(
          env,
          { from: fromAddress(env), to: buyer, reply_to: REPLY_TO, ...backup },
          `gift-buyer-email-${session.id}-${unit.unitKey}`
        );
      } catch (err) {
        console.warn("Non-fatal: buyer confirmation email failed:", err && err.message);
      }
    }
    issued.push({ code, unitKey: unit.unitKey, amountCents: unit.amountCents });
  }
  return issued;
}

/**
 * An abandoned checkout. The hold goes back on the card and the ephemeral
 * coupon is deleted -- left alone it is a live `amount_off` coupon in the
 * Stripe account, usable by anyone who learns its id, for money the shopper
 * still has.
 */
async function handleSessionExpired(session, env) {
  const metadata = session.metadata || {};
  const results = {};
  const code = metadata.gift_card_redeemed_code;
  if (code) {
    results.release = await giftCardLedger(env, code).release({
      sessionId: session.id,
      reason: "session_expired"
    });
  }
  if (metadata.gift_card_ephemeral_coupon_id) {
    results.couponDeleted = await deleteCoupon(env, metadata.gift_card_ephemeral_coupon_id);
    if (!results.couponDeleted) {
      throw new Error(
        `Could not delete ephemeral coupon ${metadata.gift_card_ephemeral_coupon_id}`
      );
    }
  }
  return results;
}

/**
 * A refunded order puts its gift-card share back on the card.
 *
 * Never more than the card paid, never more than has actually been refunded,
 * and never twice for the same money. Stripe re-sends `charge.refunded` for
 * each partial refund as well as on retry, so the amount already restored for
 * THIS charge is read back off the ledger and only the difference is credited.
 */
async function handleChargeRefunded(charge, env) {
  const paymentIntentId =
    charge.payment_intent && typeof charge.payment_intent === "object"
      ? charge.payment_intent.id
      : charge.payment_intent;
  if (!paymentIntentId) return null;

  const session = await findSessionByPaymentIntent(env, paymentIntentId);
  if (!session) return null;

  const metadata = session.metadata || {};
  const code = metadata.gift_card_redeemed_code;
  const appliedCents = Number(metadata.gift_card_amount_applied_cents || 0);
  if (!code || !(appliedCents > 0)) return null;

  const refundedCents = Number(charge.amount_refunded || 0);
  if (!(refundedCents > 0)) return null;
  const restorableCents = Math.min(appliedCents, refundedCents);

  const ledger = giftCardLedger(env, code);
  const history = await ledger.history();
  const alreadyRestored = (history.ledger || [])
    .filter(
      (row) =>
        row.kind === "restore" &&
        typeof row.external_id === "string" &&
        (row.external_id === charge.id || row.external_id.startsWith(`${charge.id}-`))
    )
    .reduce((sum, row) => sum + Number(row.delta_cents || 0), 0);

  const deltaCents = restorableCents - alreadyRestored;
  if (deltaCents <= 0) return { code: ledger.code, restoredCents: 0, alreadyRestored: true };

  // The key carries the cumulative restorable total, so a redelivery of the
  // same refund is an exact no-op while a LARGER later refund is a new claim
  // for its own difference.
  const result = await ledger.restore({
    chargeId: `${charge.id}-${restorableCents}`,
    cents: deltaCents
  });

  const to =
    result.recipientEmail || (charge.billing_details && charge.billing_details.email) || null;
  if (to) {
    const body = refundEmailBody(ledger.code, deltaCents, result.balanceCents);
    try {
      await sendEmail(
        env,
        { from: fromAddress(env), to, reply_to: REPLY_TO, ...body },
        `gift-refund-email-${charge.id}-${restorableCents}`
      );
    } catch (err) {
      // The money is back on the card; an unsent notice is not worth replaying
      // the whole event for.
      console.warn("Non-fatal: refund notification email failed:", err && err.message);
    }
  }
  return { code: ledger.code, restoredCents: deltaCents, balanceCents: result.balanceCents };
}

/**
 * The order signal the whole retention sequence hangs off.
 *
 * ONE LIGHTWEIGHT ROW, not a copy of the order -- Stripe stays the system of
 * record (docs/STATE-LAYER.md). What is stored is the address, its hash, the
 * product ids and categories, and the timestamp: exactly what a delayed email
 * needs to be written days later without calling Stripe back.
 *
 * The product ids come from session metadata written at checkout
 * (`retention_product_ids` / `retention_categories` in workers/checkout.js), so
 * this costs no extra Stripe request. Both writes are INSERT OR IGNORE, so a
 * redelivered event records nothing and queues nothing.
 */
async function recordAndSchedule(session, env, now = Date.now()) {
  if (!env.STATE_DB) return null;
  const email = buyerEmailOf(session);
  if (!email) return null;
  const metadata = session.metadata || {};
  const splitList = (value) =>
    String(value || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

  const signal = await recordOrder(
    env.STATE_DB,
    {
      orderId: session.id,
      email,
      productIds: splitList(metadata.retention_product_ids),
      categories: splitList(metadata.retention_categories)
    },
    now
  );
  const queued = await scheduleOrderSequence(
    env.STATE_DB,
    {
      order_id: session.id,
      email,
      placed_at: now,
      product_ids: splitList(metadata.retention_product_ids).join(","),
      categories: splitList(metadata.retention_categories).join(",")
    },
    now
  );
  return { recorded: signal.recorded, queued };
}

/**
 * Points for this order, and a payout if the balance has reached the threshold.
 *
 * Runs off the webhook and nowhere else: a credit on the strength of a request
 * body is exactly the hole audit finding C-1 closed. `credit` is idempotent on
 * the order id, so a redelivery pays nothing twice.
 */
async function creditPoints(session, env, ctx, now = Date.now()) {
  if (!env.STATE_DB) return null;
  const email = buyerEmailOf(session);
  if (!email) return null;
  // `amount_subtotal` is the goods before shipping and tax -- points are earned
  // on what was bought, not on the postage.
  const cents = Number(
    session.amount_subtotal !== undefined && session.amount_subtotal !== null
      ? session.amount_subtotal
      : session.amount_total
  );
  if (!Number.isFinite(cents) || cents <= 0) return null;
  return creditLoyaltyForOrder(env, ctx, { orderId: session.id, email, amountCents: cents }, now);
}

/**
 * Books this order's revenue in Umami, once, from the server.
 *
 * THIS FUNCTION MUST NEVER THROW AND MUST NEVER BE AWAITED IN A WAY THAT CAN
 * FAIL THE WEBHOOK. It is the only step here that talks to a third party that
 * has nothing to do with the order being fulfilled. Everything it can go wrong
 * about -- no binding, no website id, an unusable amount, a timeout, a rejected
 * User-Agent -- returns a reason and logs it. A thrown error here would make
 * the webhook answer non-2xx, which makes Stripe redeliver, which re-runs the
 * money path. Analytics is not allowed to cost that.
 *
 * `payment_status` is checked explicitly rather than trusted from the event
 * type: `checkout.session.completed` fires for a session that COMPLETED, which
 * for an asynchronous payment method can mean "unpaid, we will tell you later".
 * Only "paid" is money. ("no_payment_required" -- a 100%-gift-card order -- is
 * deliberately NOT reported: Stripe captured nothing, so booking it as revenue
 * would inflate the takings by the value of a card the shop had already been
 * paid for once.)
 *
 * @returns {Promise<object|null>} an outcome for the webhook's own log/response.
 */
async function reportRevenue(session, env, ctx) {
  if (!env.STATE_DB) return { sent: false, reason: "no-state-db" };
  if (session.payment_status !== "paid") {
    return { sent: false, reason: `payment-status-${session.payment_status || "unknown"}` };
  }
  const websiteId = String(env.UMAMI_WEBSITE_ID || "").trim();
  /* Read from the Worker's own env, never from the site build: the Worker has
     no filesystem and no access to assets/data/content.json, and a Worker that
     silently stopped reporting revenue because a static build changed would be
     the worst kind of failure. Unset is a defined state -- log once and do
     nothing, exactly like the unset coupon ids. */
  if (!websiteId) {
    console.warn("stripe-webhook: UMAMI_WEBSITE_ID is not set -- revenue is not being reported");
    return { sent: false, reason: "not-configured" };
  }

  const body = buildOrderPaidPayload(session, websiteId);
  if (!body) return { sent: false, reason: "unusable-amount" };

  /* Claimed BEFORE the send and never released afterwards. A redelivered
     Stripe event (or a retry after some later step threw) must not book the
     same money twice -- an analytics send is not idempotent at the far end,
     and an overstated Revenue report is worse than a missing row because it
     looks right. */
  let claimed = false;
  try {
    claimed = await claimAnalyticsSend(env.STATE_DB, ORDER_PAID, session.id);
  } catch (err) {
    console.error("analytics: could not claim the revenue send:", err && err.message);
    return { sent: false, reason: "claim-failed" };
  }
  if (!claimed) return { sent: false, reason: "already-sent" };

  /* Fire and forget. waitUntil keeps the isolate alive until the POST settles
     without holding the webhook's response, so Stripe gets its 200 at the same
     speed it did before analytics existed. */
  const attempt = sendToUmami(body).then(async (outcome) => {
    if (!outcome.sent) {
      console.error(`analytics: "Order Paid" was not recorded (${outcome.reason})`);
      /* Only give the claim back when the request provably never left. A send
         that timed out or returned a bad status may well have been recorded at
         the other end, and re-sending it would double-count. */
      if (outcome.reason === "no-fetch") {
        try {
          await releaseAnalyticsSend(env.STATE_DB, ORDER_PAID, session.id);
        } catch {
          /* best-effort */
        }
      }
    }
    return outcome;
  });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(attempt);
  return { sent: true, queued: true, revenue: body.payload.data.revenue };
}

/**
 * Runs the sub-handlers for one verified event. Each is isolated: a failure is
 * collected, not propagated immediately, so one broken step cannot stop the
 * others from running. Anything collected is re-thrown at the end so Stripe
 * retries the event as a whole -- which is safe because every step is
 * idempotent.
 */
export async function processStripeEvent(event, env, ctx) {
  const failures = [];
  const outcome = { type: event.type };

  if (event.type === "checkout.session.completed") {
    const session = event.data.object || {};
    try {
      outcome.redemption = await settleRedemption(session, env);
    } catch (err) {
      failures.push(`redemption: ${err && err.message}`);
    }
    try {
      outcome.issued = await issuePurchasedCards(session, env);
    } catch (err) {
      failures.push(`gift-card issue: ${err && err.message}`);
    }
    try {
      outcome.retention = await recordAndSchedule(session, env);
    } catch (err) {
      failures.push(`retention: ${err && err.message}`);
    }
    try {
      outcome.loyalty = await creditPoints(session, env, ctx);
    } catch (err) {
      failures.push(`loyalty: ${err && err.message}`);
    }
    try {
      outcome.giftNote = await emailGiftNoteLink(session, env);
    } catch (err) {
      failures.push(`gift-note: ${err && err.message}`);
    }
    try {
      outcome.sizeConfirmation = await emailSizeConfirmation(session, env, ctx);
    } catch (err) {
      failures.push(`size-confirmation: ${err && err.message}`);
    }
    /* Deliberately NOT pushed to `failures`. Every other step above is part of
       fulfilling the order, so a failure there should make Stripe redeliver.
       This one is a number on a dashboard: it must never be the reason the
       money path runs again. reportRevenue does not throw, and the catch is
       here anyway because "does not throw" is a promise the next edit could
       break. */
    try {
      outcome.revenue = await reportRevenue(session, env, ctx);
    } catch (err) {
      console.error("analytics: revenue reporting threw (ignored):", err && err.message);
      outcome.revenue = { sent: false, reason: "threw" };
    }
  } else if (event.type === "checkout.session.expired") {
    const session = event.data.object || {};
    try {
      outcome.expired = await handleSessionExpired(session, env);
    } catch (err) {
      failures.push(`expiry: ${err && err.message}`);
    }
    try {
      // Only when Stripe issued a recovery URL, the shopper left an address,
      // AND they opted in to promotional email in Checkout's own consent box.
      outcome.recovery = env.STATE_DB ? await scheduleRecoveryEmail(env.STATE_DB, session) : null;
    } catch (err) {
      failures.push(`recovery: ${err && err.message}`);
    }
  } else if (event.type === "charge.refunded") {
    try {
      outcome.refund = await handleChargeRefunded(event.data.object || {}, env);
    } catch (err) {
      failures.push(`refund: ${err && err.message}`);
    }
  } else {
    outcome.ignored = true;
  }

  if (failures.length) {
    const error = new Error(failures.join("; "));
    error.partial = outcome;
    throw error;
  }
  return outcome;
}

export async function handleStripeWebhook(request, env, origin, ctx) {
  // Startup guard. Without the ledger there is nowhere to record a gift card,
  // and processing an order without it is worse than not processing it: 503
  // is a retryable status, so Stripe holds the event for us.
  //
  // STATE_DB (D1) is different: it only backs the exactly-once claim. Every
  // effect below is idempotent on its own (the ledger keys issue/commit/
  // release/restore on session or charge ids; Resend sends carry idempotency
  // keys), so a redelivery without the claim table is harmless. The binding
  // is optional until the owner has run `wrangler d1 create` (see
  // workers/README.md); the Worker logs once per isolate and carries on.
  if (!env.GIFT_CARD_LEDGER) {
    console.error("stripe-webhook: GIFT_CARD_LEDGER binding is missing");
    return json({ received: false, error: "state_unavailable" }, 503, origin, env);
  }
  const hasClaimTable = Boolean(env.STATE_DB);
  if (!hasClaimTable && !warnedNoStateDb) {
    warnedNoStateDb = true;
    console.warn(
      "stripe-webhook: STATE_DB binding is missing -- processing without the exactly-once claim table"
    );
  }

  const rawBody = await request.text();
  let event;
  try {
    event = await verifyStripeSignature(
      rawBody,
      request.headers.get("Stripe-Signature"),
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    // Real reason to the log, fixed string to the caller.
    console.error("Webhook signature verification failed:", err && err.message);
    return json({ error: "Invalid signature" }, 400, origin, env);
  }

  if (!event || typeof event.id !== "string") {
    return json({ error: "Invalid signature" }, 400, origin, env);
  }

  let claimed = false;
  try {
    if (hasClaimTable) {
      // Lazily, once per isolate: the Worker has no filesystem, so the schema
      // is applied from migrations.js rather than read from workers/schema.sql.
      await ensureSchema(env.STATE_DB);

      claimed = await claimEvent(env.STATE_DB, event.id, event.type);
      if (!claimed) {
        // A redelivery. Everything this event was going to do has already
        // been started or finished; doing it again is exactly what the claim
        // exists to prevent.
        return json({ received: true, duplicate: true }, 200, origin, env);
      }
    }

    await processStripeEvent(event, env, ctx);
    if (hasClaimTable) await markEventDone(env.STATE_DB, event.id);
    return json({ received: true }, 200, origin, env);
  } catch (err) {
    console.error("Webhook processing error:", err && (err.stack || err.message));
    if (claimed) {
      // Give the claim back, or Stripe's retries all no-op against a row that
      // says "someone is already handling this".
      try {
        await releaseEvent(env.STATE_DB, event.id);
      } catch (releaseErr) {
        console.error("Could not release the webhook claim:", releaseErr && releaseErr.message);
      }
    }
    return json({ received: false, error: "processing_failed" }, 500, origin, env);
  }
}
